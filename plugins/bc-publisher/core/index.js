// BC Publisher core: host-neutral, no npm dependencies, no mods API.
// Compile and publish both go through the AL tool (`altool`, installed as the dotnet tool `al`).
// All I/O arrives through `io`:
//   io.run(argv, init) -> { exitCode, stdout, stderr }           quick calls (--version, az tokens, docker ps)
//   io.spawn(argv, { cwd, input }) -> async iterator of { stream, text }, returning { code }   streamed jobs
//   io.fetch(url, init) -> { status, ok, text }                  io.fs { read, write, list, exists, stat }
//   io.credentials() -> { user, password }   for symbol download only (BC_SERVER_USERNAME / BC_SERVER_PASSWORD)
//   io.home, io.now()
import { appContaining, appFileName, discoverApps as discover, resolveWorkspaceRoot } from './apps.js'
import { compileApp as compile, findAlTool, findCompiler, isUpToDate, readApp } from './compile.js'
import { listContainers, listSaas, mergeEnvironments, parseLaunch } from './envs.js'
import { defaultMode, publishApp as publish, publishBlock } from './publish.js'
import { downloadSymbols as symbols } from './symbols.js'
import { buildErrorPrompt, getLastRun as lastRun, recordRun } from './runs.js'
import { errorMessage, joinPath, parseJsonc } from './util.js'

export { buildErrorPrompt, publishBlock }

// The example is inert on purpose: it is read back as real config on the next run, so it grants nothing.
const EXAMPLE_CONFIG = {
  _comment: 'BC Publisher config. No secrets here: SaaS uses `al auth login`, servers read BC_SERVER_USERNAME / BC_SERVER_PASSWORD from the environment.',
  tenants: [{ id: '00000000-0000-0000-0000-000000000000', label: 'Customer A', domain: 'customera.onmicrosoft.com' }],
  environments: [
    { id: 'container:bc28', agentMayPublish: false, _comment: 'Set agentMayPublish to true to let the agent publish to this local container.' },
    { id: 'onprem:myserver/bc', allowPublish: false, _comment: 'On-prem servers may be production: set allowPublish to true to publish.' },
  ],
}

export function createPublisher(io, { workspaceRoot }) {
  let environments = null
  const errors = []

  async function loadConfig() {
    const path = joinPath(io.home, '.bc-publisher', 'config.json')
    if (!(await io.fs.exists(path))) {
      await io.fs.write(path, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n')
      return { tenants: [], environments: [], isExample: true, path }
    }
    try {
      // JSONC (the folder is shared with other tools that comment their config); "environments" may be a list
      // of { id, ... } or an object keyed by id
      const parsed = parseJsonc(await io.fs.read(path))
      const envs = parsed.environments
      const environments = Array.isArray(envs) ? envs : envs && typeof envs === 'object' ? Object.entries(envs).map(([id, v]) => ({ id, ...v })) : []
      return { tenants: [], ...parsed, environments, path }
    } catch (e) {
      throw new Error(`Cannot parse ${path}: ${errorMessage(e)}`)
    }
  }

  // `workspaceRoot` is where the session started (often inside one app); the workspace is found from there
  let root
  const resolvedRoot = async () => (root ??= await resolveWorkspaceRoot(io, workspaceRoot))
  const discoverApps = async () => discover(io, await resolvedRoot())
  const currentApp = apps => appContaining(apps, workspaceRoot)

  /** Which compiler/publisher is in use, for the header. */
  async function toolStatus() {
    const tool = await findAlTool(io)
    if (tool) return { label: 'altool', version: tool.version, ok: true }
    const compiler = await findCompiler(io)
    return { label: compiler?.label ?? 'none', version: compiler?.version, ok: false, hint: 'Install the AL tool to publish: dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools' }
  }

  /** Merges launch.json targets, local containers and SaaS tenants. Failures of one source never hide the others. */
  async function discoverEnvironments() {
    errors.length = 0
    let config
    try {
      config = await loadConfig()
    } catch (e) {
      // The config holds safety settings (isProduction, allowPublish). Without it nothing may be published to, and
      // the empty answer must not be remembered, so the next call reads the file again.
      errors.push({ source: 'config', message: `${errorMessage(e)}. No targets are offered until it is fixed.` })
      environments = null
      return []
    }
    const apps = await discoverApps().catch(() => [])
    const launch = []
    for (const app of apps) {
      try {
        launch.push(...parseLaunch(await io.fs.read(joinPath(app.path, '.vscode', 'launch.json')), 'launch.json'))
      } catch {
        /* no launch.json in this app */
      }
    }
    const [containers, saas] = await Promise.all([
      listContainers(io).catch(e => (errors.push({ source: 'containers', message: errorMessage(e) }), [])),
      Promise.all(
        (config.tenants ?? [])
          .filter(t => t.id && !/^0+(-0+)*$/.test(t.id))
          .map(t => listSaas(io, t, config.adminApiVersion).catch(e => (errors.push({ source: `tenant ${t.label ?? t.id}`, message: errorMessage(e) }), []))),
      ).then(r => r.flat()),
    ])
    environments = mergeEnvironments(launch, containers, saas, config.tenants).map(e => {
      const own = config.environments?.find(c => c.id === e.id) ?? {}
      return {
        ...e,
        isProduction: e.isProduction || !!own.isProduction, // a person can only ever make a target safer
        agentMayPublish: !!own.agentMayPublish,
        allowPublish: !!own.allowPublish,
      }
    })
    return environments
  }

  async function findEnvironment(id) {
    return (environments ?? (await discoverEnvironments())).find(e => e.id === id) ?? null
  }

  const compileApp = (appPath, opts) => compile(io, appPath, opts)

  /** Separate, explicit action after AL1022: fetch the symbol packages from a container or on-prem server. */
  async function downloadSymbols(appPath, environmentId, opts) {
    const env = await findEnvironment(environmentId)
    if (!env || env.isProduction || env.kind === 'saas' || (env.kind === 'onprem' && !env.allowPublish)) {
      throw new Error(publishBlock(env) ?? 'Symbols can only be downloaded from a container or an allowed on-prem server.')
    }
    return symbols(io, appPath, env, await io.credentials?.(), opts)
  }
  const getLastRun = environmentId => lastRun(io, environmentId)

  /**
   * Compile (unless skipCompile and up to date) then publish. Resolves a run record, recorded in runs.json,
   * also when the target is refused: every publish, allowed or not, leaves one audited trace.
   */
  async function publishApp(appPath, environmentId, { mode, skipCompile = false, onOutput, onStage, handle, requestedBy = 'user' } = {}) {
    const startedAt = io.now()
    const app = await readApp(io, appPath)
    const env = await findEnvironment(environmentId)
    const run = {
      id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      appId: app.id,
      appName: app.name,
      appVersion: app.version,
      appPath,
      environmentId,
      environmentLabel: env?.label ?? environmentId,
      requestedBy,
      startedAt,
      mode: mode ?? defaultMode(env),
      stage: 'queued',
      ok: false,
      diagnostics: [],
      tail: [],
    }
    const finish = async patch => {
      Object.assign(run, patch, { durationMs: io.now() - startedAt })
      onStage?.(run.ok ? 'done' : 'failed', run)
      return recordRun(io, run)
    }

    const blocked = publishBlock(env)
    if (blocked) return finish({ stage: 'blocked', error: blocked, tail: [blocked], command: '(refused)' })

    try {
      onStage?.('queued', run)
      let appFile = joinPath(appPath, appFileName(app))
      if (skipCompile && (await isUpToDate(io, appPath, appFile).catch(() => false))) {
        onOutput?.('Skipping compile: the .app is newer than every source file.')
      } else {
        run.stage = 'compiling'
        onStage?.('compiling', run)
        const c = await compile(io, appPath, { onOutput, handle })
        if (!c.ok) {
          return finish({
            stage: 'compiling',
            diagnostics: c.diagnostics,
            tail: c.tail,
            command: c.command,
            missingSymbols: c.missingSymbols,
            error: c.error ?? (c.cancelled ? 'cancelled' : `${c.diagnostics.filter(d => d.severity === 'error').length} compile error(s)`),
          })
        }
        appFile = c.appFile
      }

      run.stage = 'publishing'
      onStage?.('publishing', run)
      const p = await publish(io, env, appFile, { mode: run.mode, onOutput, handle })
      return finish({ stage: 'publishing', ok: p.ok, command: p.command, tail: p.lines.slice(-30), error: p.error })
    } catch (e) {
      return finish({ error: errorMessage(e), tail: [errorMessage(e)] })
    }
  }

  return {
    loadConfig,
    toolStatus,
    discoverApps,
    resolvedRoot,
    currentApp,
    discoverEnvironments,
    findEnvironment,
    compileApp,
    downloadSymbols,
    publishApp,
    getLastRun,
    buildErrorPrompt,
    get errors() {
      return [...errors]
    },
  }
}

/** Plain text for `claude -p` and the tools. */
export function appsToText(apps) {
  return apps.length ? apps.map(a => `- ${a.name} ${a.version} (${a.publisher})${a.dependsOn.length ? ` ← ${a.dependsOn.join(', ')}` : ''}\n  ${a.path}`).join('\n') : 'No app.json found in the workspace.'
}

export function environmentsToText(envs) {
  return envs.length
    ? envs.map(e => `- ${e.id}  ${e.label}  [${e.kind}${e.isProduction ? ', PRODUCTION: read-only' : ''}]  ${[e.details?.bcVersion, e.details?.country, e.details?.state].filter(Boolean).join(' ')}`).join('\n')
    : 'No environments found.'
}
