import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { appsToText, buildErrorPrompt, createPublisher, environmentsToText, publishBlock } from '../core/index.js'
import type { App, Environment, Job, Run, Stage } from '../types'

const PANE = 'publisher'
const MAX_LINES = 200
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const STAGES: Stage[] = ['queued', 'compiling', 'publishing', 'done']

const workspace = atom({ plugin: 'bc-publisher', key: 'workspace' } as const, '')
const alcVersion = atom({ plugin: 'bc-publisher', key: 'alcVersion' } as const, null)
const apps = atom({ plugin: 'bc-publisher', key: 'apps' } as const, [])
const environments = atom({ plugin: 'bc-publisher', key: 'environments' } as const, [])
const selected = atom({ plugin: 'bc-publisher', key: 'selected' } as const, [])
const lastRuns = atom({ plugin: 'bc-publisher', key: 'lastRuns' } as const, {})
const sourceErrors = atom({ plugin: 'bc-publisher', key: 'sourceErrors' } as const, [])
const isLoading = atom({ plugin: 'bc-publisher', key: 'isLoading' } as const, false)
// 'Auto' = untouched: the target decides (launch.json schemaUpdateMode, else Add)
const syncMode = atom({ plugin: 'bc-publisher', key: 'syncMode' } as const, 'Auto')
const jobAtom = atom({ plugin: 'bc-publisher', key: 'job' } as const, null)
const tick = atom({ plugin: 'bc-publisher', key: 'tick' } as const, 0)
const showLog = atom({ plugin: 'bc-publisher', key: 'showLog' } as const, false)
const isBandDismissed = atom({ plugin: 'bc-publisher', key: 'isBandDismissed' } as const, false)

let publisher: ReturnType<typeof createPublisher> | undefined
let handle: { cancel?: () => unknown } = {}
let isBusy = false
let pending: string[] = []
let isFlushScheduled = false
let ticker: { cancel: () => void } | undefined

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
const text = (value: string, isError = false) => ({ result: { content: [{ type: 'text', text: value }], isError } })
const json = (value: unknown) => text(JSON.stringify(value))

// ── data ───────────────────────────────────────────────────────────────────

// The refresh in flight, so a command that needs the apps can wait for it instead of racing it.
let discovering: Promise<void> | undefined
function refreshAll($: any): Promise<void> {
  discovering = refreshNow($)
  return discovering
}

async function refreshNow($: any) {
  if (!publisher) return
  await update($, isLoading, () => true)
  try {
    const tool = await publisher.toolStatus()
    await update($, alcVersion, () => (tool.label === 'none' ? null : `${tool.label} ${tool.version ?? ''}`.trim()))
    const list: App[] = await publisher.discoverApps()
    await update($, apps, () => list)
    const rootDir: string = await publisher.resolvedRoot()
    await update($, workspace, () => rootDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? rootDir)
    // keep what was ticked; otherwise start with the app you are standing in, so Publish works at once
    await update($, selected, (cur: string[]) => {
      const keep = cur.filter(p => list.some(a => a.path === p))
      if (keep.length) return keep
      const here = publisher!.currentApp(list)
      return here ? [here.path] : []
    })
    const envs: Environment[] = await publisher.discoverEnvironments()
    await update($, environments, () => envs)
    await update($, sourceErrors, () => [...publisher!.errors, ...(tool.ok ? [] : [{ source: 'AL tool', message: tool.hint ?? 'not found' }])])
    const runs: Record<string, { ok: boolean; at: number; app: string; version: string }> = {}
    for (const e of envs) {
      const r = await publisher.getLastRun(e.id)
      if (r) runs[e.id] = { ok: r.ok, at: r.startedAt, app: r.appName, version: r.appVersion }
    }
    await update($, lastRuns, () => runs)
  } catch (e) {
    await update($, sourceErrors, () => [{ source: 'discovery', message: e instanceof Error ? e.message : String(e) }])
  } finally {
    await update($, isLoading, () => false)
  }
}

async function resolveApp($: any, appPath: string): Promise<App | null> {
  const list: App[] = await read($, apps)
  return list.find(a => norm(a.path) === norm(appPath) || a.name.toLowerCase() === appPath.toLowerCase()) ?? null
}

// ── jobs ───────────────────────────────────────────────────────────────────

function pushLine($: any, line: string) {
  pending.push(line)
  if (isFlushScheduled) return
  isFlushScheduled = true
  // output streams fast; redraw at most about four times a second
  $.clock.after(250, () => void flush($))
}

async function flush($: any) {
  isFlushScheduled = false
  const lines = pending
  pending = []
  if (lines.length) await update($, jobAtom, (j: Job | null) => (j ? { ...j, lines: [...j.lines, ...lines].slice(-MAX_LINES) } : j))
}

async function setJob($: any, patch: Partial<Job> | null, initial?: Job) {
  await update($, jobAtom, (j: Job | null) => (patch === null ? null : initial ?? (j ? { ...j, ...patch } : j)))
}

async function beginJob($: any, job: Job) {
  if (isBusy) throw new Error('Another compile/publish job is already running. Wait for it or cancel it in /publish.')
  isBusy = true
  handle = {}
  pending = []
  await update($, isBandDismissed, () => false)
  await setJob($, null, undefined)
  await update($, jobAtom, () => job)
  ticker = $.clock.every(500, () => void update($, tick, (n: number) => n + 1))
}

async function endJob($: any, patch: Partial<Job>) {
  ticker?.cancel()
  ticker = undefined
  isBusy = false
  await flush($)
  await setJob($, patch)
}

async function recordResult($: any, run: Run) {
  if (run.environmentId) {
    await update($, lastRuns, (m: Record<string, unknown>) => ({ ...m, [run.environmentId]: { ok: run.ok, at: run.startedAt, app: run.appName, version: run.appVersion } }))
  }
}

/** Compile + publish each app (in the order given) to one target. Resolves the run records. */
async function runPublish($: any, appPaths: string[], environmentId: string, o: { requestedBy: string; mode?: string; skipCompile?: boolean }): Promise<Run[]> {
  const env: Environment | undefined = (await read($, environments)).find((e: Environment) => e.id === environmentId)
  // Only a mode somebody chose is explicit: the pane's selector once it has been touched, or what the agent asked for.
  // An untouched selector, and every agent call that names none, defer to the target's own default in core.
  const chosen = await read($, syncMode)
  const mode = o.mode ?? (o.requestedBy === 'agent' || chosen === 'Auto' ? undefined : chosen)
  const names = await Promise.all(appPaths.map(async p => (await resolveApp($, p))?.name ?? p))
  await beginJob($, {
    id: String(await $.clock.now()),
    title: names.length > 1 ? `${names.length} apps` : names[0],
    environmentId,
    stage: 'queued',
    startedAt: await $.clock.now(),
    progress: `1/${appPaths.length}`,
    lines: [],
    run: null,
    requestedBy: o.requestedBy,
  })
  const runs: Run[] = []
  try {
    for (const [i, appPath] of appPaths.entries()) {
      await setJob($, { progress: `${i + 1}/${appPaths.length}`, title: names.length > 1 ? `${names[i]} (${i + 1}/${names.length})` : names[i] })
      const run: Run = await publisher!.publishApp(appPath, environmentId, {
        mode,
        skipCompile: o.skipCompile,
        requestedBy: o.requestedBy,
        handle,
        onOutput: (l: string) => pushLine($, l),
        onStage: (s: Stage) => void setJob($, { stage: s }),
      })
      runs.push(run)
      await recordResult($, run)
      if (!run.ok) break
    }
  } finally {
    const last = runs.at(-1) ?? null
    await endJob($, { stage: last?.ok ? 'done' : 'failed', run: last })
  }
  void env
  return runs
}

async function runCompile($: any, appPath: string, requestedBy: string) {
  const app = await resolveApp($, appPath)
  if (!app) throw new Error(`Not an app in this workspace: ${appPath}`)
  await beginJob($, { id: String(await $.clock.now()), title: app.name, environmentId: null, stage: 'compiling', startedAt: await $.clock.now(), progress: '1/1', lines: [], run: null, requestedBy })
  try {
    const c = await publisher!.compileApp(app.path, { handle, onOutput: (l: string) => pushLine($, l) })
    if (c.compiler) await update($, alcVersion, () => `${c.compiler.label} ${c.compiler.version}`)
    const run: Run = {
      id: `compile-${await $.clock.now()}`,
      appId: app.id,
      appName: app.name,
      appVersion: app.version,
      appPath: app.path,
      environmentId: '',
      environmentLabel: 'compile only',
      requestedBy,
      startedAt: await $.clock.now(),
      durationMs: c.durationMs ?? 0,
      stage: 'compiling',
      ok: c.ok,
      diagnostics: c.diagnostics,
      tail: c.tail,
      command: c.command,
      error: c.error,
      missingSymbols: c.missingSymbols,
    }
    await endJob($, { stage: c.ok ? 'done' : 'failed', run })
    return { ...c, run }
  } catch (e) {
    await endJob($, { stage: 'failed' })
    throw e
  }
}

async function cancelJob($: any) {
  await handle.cancel?.()
}

async function askAgent($: any, run: Run) {
  void $.prompt.submit({ text: buildErrorPrompt(run) })
}

/** A target symbols can come from: the run's own container/server, else the first running container. */
async function symbolSource($: any, run: Run): Promise<Environment | undefined> {
  const envs: Environment[] = await read($, environments)
  const fits = (e: Environment) => !e.isProduction && (e.kind === 'container' || (e.kind === 'onprem' && e.allowPublish))
  return envs.find(e => e.id === run.environmentId && fits(e)) ?? envs.find(e => fits(e) && e.details.state !== 'exited')
}

async function downloadSymbols($: any, run: Run) {
  const env = await symbolSource($, run)
  if (!env) return $.ui.toast('No container or allowed server to download symbols from.')
  await beginJob($, { id: String(await $.clock.now()), title: `symbols for ${run.appName}`, environmentId: env.id, stage: 'compiling', startedAt: await $.clock.now(), progress: '1/1', lines: [], run: null, requestedBy: 'user' })
  try {
    const r = await publisher!.downloadSymbols(run.appPath, env.id, { handle, onOutput: (l: string) => pushLine($, l) })
    await endJob($, { stage: r.ok ? 'done' : 'failed', run: r.ok ? null : { ...run, error: r.failed.map((f: { name: string; error: string }) => `${f.name}: ${f.error}`).join('; '), diagnostics: [], missingSymbols: false } })
  } catch (e) {
    await endJob($, { stage: 'failed', run: { ...run, error: e instanceof Error ? e.message : String(e), diagnostics: [], missingSymbols: false } })
  }
}

async function toggleApp($: any, path: string) {
  await update($, selected, (cur: string[]) => (cur.includes(path) ? cur.filter(p => p !== path) : [...cur, path]))
}

// ── tool gate ──────────────────────────────────────────────────────────────

/** Why an agent may not publish here (null: allowed, maybe after asking the person). */
function agentBlock(env: Environment | undefined): string | null {
  const why = publishBlock(env as any)
  if (why) return why
  if (env!.kind !== 'saas' && !env!.agentMayPublish) {
    return `The agent may not publish to ${env!.label} without permission. The person can allow it by adding { "id": "${env!.id}", "agentMayPublish": true } to "environments" in ~/.bc-publisher/config.json, or publish from /publish.`
  }
  return null
}

/** What the Bash/PowerShell guard decides for a command that publishes outside the publisher. */
function publishAttempt(command: string, envs: Environment[]): { reason: string } | null {
  // The publisher's own engine counts too: `al publishapp` / `altool publishapp`, bare or by quoted path.
  const altool = /(?:^|[\s"'\\/])(?:al|altool)(?:\.exe)?["']?\s+publishapp\b/i.test(command)
  const isPublish = altool || /Publish-BcContainerApp|Publish-NAVApp|\/dev\/apps\b/i.test(command)
  if (!isPublish) return null
  if (altool) {
    // production by name or by type is refused outright; so is any SaaS target this list cannot vouch for
    const named = command.match(/--environmentname\s+["']?([^\s"']+)/i)?.[1]?.toLowerCase()
    const isProdType = /--environmenttype\s+["']?production/i.test(command)
    const known = named ? envs.find(x => x.kind === 'saas' && x.details.environmentName?.toLowerCase() === named) : undefined
    if (isProdType || (named && (!known || known.isProduction || known.type !== 'Sandbox'))) {
      return { reason: `Publishing to ${named ?? 'production'} is blocked: it is a production environment or its type cannot be determined. Production is never published to from here.` }
    }
  }
  const container = command.match(/-containerName\s+['"]?([\w.-]+)/i)?.[1]
  const dev = command.match(/\/v2\.0\/([^/\s'"]+)\/([^/\s'"]+)\/dev\/apps/i)
  const id = container ? `container:${container.toLowerCase()}` : dev ? `saas:${dev[1].toLowerCase()}/${dev[2].toLowerCase()}` : null
  const env = id ? envs.find(e => e.id === id || (dev && e.kind === 'saas' && e.details.environmentName?.toLowerCase() === dev[2].toLowerCase())) : undefined
  if (dev && (!env || env.isProduction || env.type !== 'Sandbox')) {
    return { reason: `Publishing to ${dev[2]} is blocked: it is a production environment or its type cannot be determined. Production is never published to from here.` }
  }
  if (/Publish-NAVApp/i.test(command)) return { reason: 'On-premises publishing is not supported through the publisher yet. Do not publish with Publish-NAVApp; ask the person.' }
  return { reason: 'Publish through the publisher tool instead, so every publish goes through one audited path: call mcp__bc-publisher__publisher_publish (appPath, environmentId). List targets with mcp__bc-publisher__publisher_list_environments.' }
}

// ── mod ────────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    publisher = createPublisher(
      {
        home,
        now: () => Date.now(),
        fs: {
          read: (p: string) => $.fs.read(p),
          write: (p: string, t: string) => $.fs.write(p, t),
          list: (p: string) => $.fs.list(p),
          exists: (p: string) => $.fs.exists(p),
          stat: (p: string) => $.fs.stat(p),
        },
        // only for symbol download from a container: altool reads these two itself when it publishes
        credentials: async () => ({ user: await $.env.get('BC_SERVER_USERNAME'), password: await $.env.get('BC_SERVER_PASSWORD') }),
        run: (argv: string[], init?: object) => $.process.run(argv, init as any),
        spawn: (argv: string[], init: { cwd?: string; input?: string } = {}) => $.process.spawn({ argv, cwd: init.cwd, input: init.input } as any),
        fetch: (url: string, init?: object) => $.http.fetch(url, init as any),
      } as any,
      { workspaceRoot: e.cwd },
    )
    await update($, workspace, () => e.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? e.cwd)

    await $.command.register({ name: 'publish', description: 'Compile and publish AL apps to Business Central environments' })

    const path = { type: 'string', description: 'Absolute path of the app folder (the one holding app.json), or the app name, as listed by publisher_list_apps' }
    const envId = { type: 'string', description: 'Environment id as listed by publisher_list_environments, for example container:bc24-w1' }
    const tools: [string, string, Record<string, unknown>?][] = [
      ['publisher_list_apps', 'Lists the AL apps in the workspace in dependency order (base apps first).'],
      ['publisher_list_environments', 'Lists publish targets (local containers, SaaS sandboxes, on-prem) with isProduction and agentMayPublish. Production targets can never be published to.'],
      ['publisher_compile', 'Compiles an AL app with alc.exe and returns the parsed diagnostics ({ severity, code, file, line, column, message }).', { type: 'object', properties: { appPath: path }, required: ['appPath'] }],
      [
        'publisher_publish',
        'Compiles then publishes an AL app to an environment through the same code path as the /publish buttons. Refuses production. SaaS sandboxes ask the person for confirmation; containers and on-prem servers need agentMayPublish (and on-prem also allowPublish). Returns the run record.',
        { type: 'object', properties: { appPath: path, environmentId: envId, mode: { type: 'string', enum: ['Add', 'ForceSync'], description: 'Schema sync mode; default Add' } }, required: ['appPath', 'environmentId'] },
      ],
      ['publisher_last_run', 'Returns the last compile/publish run recorded for an environment.', { type: 'object', properties: { environmentId: envId }, required: ['environmentId'] }],
    ]
    for (const [name, description, inputSchema] of tools) await $.tool.register({ name, description, inputSchema, isDeferred: false })

    void refreshAll($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    await handle.cancel?.()
    return next(e)
  })

  // ── /publish ─────────────────────────────────────────────────────────────

  on('command.run', { command: 'publish' }, async ($, e) => {
    // words, or "quoted phrases" (app names and Windows paths contain spaces)
    const [verb, a, b] = [...e.args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3])
    // the first discovery runs from session start: wait for it, and run one if there has been none
    if (verb === 'compile' || verb === 'publish') {
      await discovering
      if ((await read($, apps)).length === 0) await refreshAll($)
    }
    if (verb === 'compile' && a) {
      const r = await runCompile($, a, 'user').catch(err => ({ error: String(err) }))
      return { text: JSON.stringify(r, null, 1) }
    }
    if (verb === 'publish' && a && b) {
      const list: App[] = await read($, apps)
      const paths = a === 'all' ? list.map(x => x.path) : [(await resolveApp($, a))?.path ?? a]
      const runs = await runPublish($, paths, b, { requestedBy: 'user' }).catch(err => [{ ok: false, error: String(err) }])
      return { text: JSON.stringify(runs, null, 1) }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Publisher' })
    if (verb === 'refresh' || (await read($, apps)).length === 0) await refreshAll($)
    if (isPlaced) return { text: 'Publisher opened.' }
    const envs: Environment[] = await read($, environments)
    return { text: `Apps\n${appsToText(await read($, apps))}\n\nEnvironments\n${environmentsToText(envs)}\n\nUse "/publish compile <app>" and "/publish publish <app|all> <environmentId>".` }
  })

  // ── tools: the same functions the buttons call ───────────────────────────

  on('tool.call', { tool: 'mcp__bc-publisher__publisher_list_apps' }, async $ => {
    const list: App[] = await publisher!.discoverApps()
    // what the tool lists is what compile and publish accept: keep the shared list in step
    await update($, apps, () => list)
    return json(list.map(({ id, name, publisher: pub, version, path, dependsOn, idRanges }: any) => ({ id, name, publisher: pub, version, path, dependsOn, idRanges })))
  })

  on('tool.call', { tool: 'mcp__bc-publisher__publisher_list_environments' }, async $ => {
    const envs: Environment[] = await publisher!.discoverEnvironments()
    await update($, environments, () => envs)
    return json(envs.map(e => ({ id: e.id, label: e.label, kind: e.kind, isProduction: e.isProduction, agentMayPublish: !!e.agentMayPublish && !e.isProduction, ...e.details })))
  })

  on('tool.call', { tool: 'mcp__bc-publisher__publisher_compile' }, async (_$, e) => {
    const { appPath } = (e as any).input as { appPath: string }
    try {
      const r = await runCompile(_$, appPath, 'agent')
      return json({ ok: r.ok, diagnostics: r.diagnostics, missingSymbols: r.missingSymbols, compiler: r.compiler ? `${r.compiler.label} ${r.compiler.version}` : null, error: r.error })
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true)
    }
  })

  on('tool.call', { tool: 'mcp__bc-publisher__publisher_publish' }, async ($, e) => {
    const { appPath, environmentId, mode } = (e as any).input as { appPath: string; environmentId: string; mode?: string }
    try {
      const app = await resolveApp($, appPath)
      if (!app) return text(`Not an app in this workspace: ${appPath}. Use publisher_list_apps.`, true)
      const envs: Environment[] = await read($, environments)
      const env = envs.find(x => x.id === environmentId) ?? (await publisher!.findEnvironment(environmentId))
      const refused = agentBlock(env as Environment | undefined)
      if (refused) {
        // A target core itself refuses (production, unknown, on-prem) leaves one audited trace: publishApp
        // spawns nothing for it. A mere missing permission must never reach publishApp, which would publish.
        const trace = publishBlock(env as any) ? await publisher!.publishApp(app.path, environmentId, { requestedBy: 'agent' }) : null
        return text(refused + (trace ? ` (recorded as run ${trace.id})` : ''), true)
      }
      if (env!.kind === 'saas') {
        const answer = await $.ui.ask(`Allow the agent to publish ${app.name} ${app.version} to the sandbox ${env!.label}?`, { options: ['Publish', 'Cancel'], header: 'Publisher' }).catch(() => 'Cancel')
        if (answer !== 'Publish') return text('The person declined publishing to the SaaS sandbox.', true)
      }
      const [run] = await runPublish($, [app.path], environmentId, { requestedBy: 'agent', mode })
      return json({ ...run, tail: run.tail.slice(-15) })
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true)
    }
  })

  on('tool.call', { tool: 'mcp__bc-publisher__publisher_last_run' }, async (_$, e) => {
    const { environmentId } = (e as any).input as { environmentId: string }
    const run = await publisher!.getLastRun(environmentId)
    return run ? json({ ...run, tail: run.tail.slice(-15) }) : text(`No run recorded for ${environmentId}.`)
  })

  // ── bonus: one audited path ──────────────────────────────────────────────

  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const found = publishAttempt(String((e as any).command ?? ''), await read($, environments))
      return found ? { deny: found.reason } : next(e)
    })
  }

  // ── band ─────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const job = await read($, jobAtom)
    if (e.props.hasSurvey) return next(e)
    const running = !!job && job.stage !== 'done' && job.stage !== 'failed'
    const showsFailure = !!job && job.stage === 'failed' && !(await read($, isBandDismissed))
    const { Box, Text, Button } = $.ui.resolve(e)
    const envs: Environment[] = await read($, environments)

    if (!running && !showsFailure) {
      // Idle: say the mod is here, but only where there are AL apps, and keep it to one quiet line.
      const appList: App[] = await read($, apps)
      if (appList.length === 0) return next(e)
      const readOnly = envs.filter(x => x.isProduction).length
      const last = job?.stage === 'done' ? job : null
      return (
        <Box columnGap={1}>
          {last && <Text color="green">✓ {last.run?.environmentId ? 'Published' : 'Compiled'} {clip(last.title, 30)} ·</Text>}
          <Text dimColor>
            BC Publisher · {appList.length} app{appList.length === 1 ? '' : 's'} · {envs.length} target{envs.length === 1 ? '' : 's'}
            {readOnly ? ` (${readOnly} read-only)` : ''}
          </Text>
          <Button key="open" plain label="/publish" onPress={() => $.ui.open({ id: PANE, title: 'Publisher', focus: true })} />
        </Box>
      )
    }
    if (!job) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const target = envs.find(x => x.id === job.environmentId)?.label

    if (running) {
      return (
        <Box columnGap={1}>
          <Text color="yellow">
            {SPINNER[Math.floor(now / 100) % SPINNER.length]} {job.stage === 'compiling' ? 'Compiling' : 'Publishing'} {clip(job.title, 40)}
            {target ? ` → ${clip(target, 30)}` : ''} · {clock(now - job.startedAt)}
          </Text>
          <Button key="cancel" plain dimColor label="cancel" onPress={() => cancelJob($)} />
        </Box>
      )
    }
    const errors = (job.run?.diagnostics ?? []).filter(d => d.severity === 'error').length
    return (
      <Box columnGap={1}>
        <Text color="red">✗ {job.environmentId ? 'Publish' : 'Compile'} failed: {errors ? `${errors} error${errors === 1 ? '' : 's'}` : (job.run?.error ?? 'see /publish')}</Text>
        {job.run && <Button key="ask" hotkey="1" label="1 Ask agent to fix" onPress={() => askAgent($, job.run!)} />}
        <Button key="dismiss" plain dimColor label="dismiss" onPress={() => update($, isBandDismissed, () => true)} />
      </Box>
    )
  })

  // ── pane ─────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const appList: App[] = await read($, apps)
    const envs: Environment[] = await read($, environments)
    const picked: string[] = await read($, selected)
    const job: Job | null = await read($, jobAtom)
    const loading = await read($, isLoading)
    const mode = await read($, syncMode)
    const runs = await read($, lastRuns)
    const errs = await read($, sourceErrors)
    const logOpen = await read($, showLog)
    const alc = await read($, alcVersion)
    await read($, tick)
    const now = await $.clock.now()
    const isRunning = !!job && job.stage !== 'done' && job.stage !== 'failed'
    const toPublish = appList.filter(a => picked.includes(a.path)).map(a => a.path)

    const header = (
      <Box columnGap={1} flexWrap="wrap">
        <Text bold>BC Publisher</Text>
        <Text dimColor>{await read($, workspace)} · {alc ?? 'AL tool not found'}</Text>
        <Button key="refresh" hotkey="r" label={loading ? 'Refreshing…' : 'Refresh'} onPress={() => refreshAll($)} />
        <Select
          key="sync"
          label="Sync:"
          value={mode}
          options={[{ value: 'Auto', label: 'Auto (per target)' }, { value: 'Add', label: 'Add' }, { value: 'ForceSync', label: 'ForceSync' }]}
          onSelect={v => update($, syncMode, () => v)}
        />
      </Box>
    )

    const appRows = (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          Apps <Text dimColor>({appList.length})</Text>
        </Text>
        {appList.length === 0 && <Text dimColor>{loading ? 'Looking for app.json…' : 'No app.json found in the workspace.'}</Text>}
        {appList.map(a => (
          <Box key={a.path} columnGap={1}>
            <Button key={`sel-${a.path}`} plain label={`${picked.includes(a.path) ? '[x]' : '[ ]'} ${clip(a.name, Math.max(12, cols - 50))} ${a.version}`} onPress={() => toggleApp($, a.path)} />
            {a.dependsOn.length > 0 && <Text dimColor>← {clip(a.dependsOn.join(', '), 24)}</Text>}
            {!isRunning && <Button key={`cmp-${a.path}`} label="Compile" onPress={() => runCompile($, a.path, 'user').catch(() => {})} />}
          </Box>
        ))}
      </Box>
    )

    const card = (env: Environment) => {
      const last = runs[env.id]
      const blockedWhy = env.isProduction ? null : publishBlock(env as any)
      const isCurrent = job?.environmentId === env.id && isRunning
      return (
        <Box key={env.id} flexDirection="column" borderStyle={isCurrent ? 'round' : undefined} borderColor={isCurrent ? 'yellow' : undefined}>
          <Text bold dimColor={env.isProduction}>
            {env.isProduction ? '🔒 ' : ''}
            {clip(env.label, cols - 20)} <Text dimColor>[{env.kind}]</Text>
          </Text>
          <Text dimColor>
            {'  '}
            {[env.details.bcVersion && `BC ${env.details.bcVersion}`, env.details.country, env.details.state].filter(Boolean).join(' · ') || '—'}
          </Text>
          {last && (
            <Text color={last.ok ? 'green' : 'red'}>
              {'  '}
              {last.ok ? '✓' : '✗'} last: {last.app} {last.version}
            </Text>
          )}
          {env.isProduction ? (
            <Text dimColor>{'  '}read-only: publishing to production is not possible from here</Text>
          ) : blockedWhy ? (
            <Text dimColor>{'  '}{clip(blockedWhy, cols - 4)}</Text>
          ) : isRunning ? (
            <Text dimColor>{'  '}busy…</Text>
          ) : (
            <Box columnGap={1} paddingLeft={2} flexWrap="wrap">
              <Button key={`pub-${env.id}`} variant="primary" label={`Publish (${toPublish.length})`} onPress={() => (toPublish.length ? runPublish($, toPublish, env.id, { requestedBy: 'user' }).catch(() => {}) : $.ui.toast('Tick one or more apps first.'))} />
              <Button key={`all-${env.id}`} label="Publish all" onPress={() => runPublish($, appList.map(a => a.path), env.id, { requestedBy: 'user' }).catch(() => {})} />
            </Box>
          )}
        </Box>
      )
    }

    const groups: [string, Environment[]][] = [
      ['Local containers', envs.filter(x => x.kind === 'container' && !x.isProduction)],
      ['SaaS sandboxes', envs.filter(x => x.kind === 'saas' && !x.isProduction)],
      ['On-prem', envs.filter(x => x.kind === 'onprem' && !x.isProduction)],
      ['Production (read-only)', envs.filter(x => x.isProduction)],
    ]
    const envBlock = groups
      .filter(([, list]) => list.length)
      .map(([title, list]) => (
        <Box key={title} flexDirection="column" marginTop={1}>
          <Text bold color={title.startsWith('Production') ? 'red' : undefined}>
            {title} <Text dimColor>({list.length})</Text>
          </Text>
          {list.map(card)}
        </Box>
      ))

    // live output / failure summary
    let output = null
    if (job) {
      const idx = STAGES.indexOf(job.stage === 'failed' ? (job.run?.stage === 'publishing' ? 'publishing' : 'compiling') : job.stage)
      const chips = STAGES.map((s, i) => {
        const here = i === idx && isRunning
        const color = job.stage === 'failed' && i === idx ? 'red' : here ? 'yellow' : i < idx || job.stage === 'done' ? 'green' : undefined
        return (
          <Text key={s} color={color as any} bold={here} dimColor={!color}>
            {here ? SPINNER[Math.floor(now / 100) % SPINNER.length] : i < idx || job.stage === 'done' ? '●' : job.stage === 'failed' && i === idx ? '✗' : '○'} {s === 'done' && job.stage === 'failed' ? 'failed' : s}
            {i < STAGES.length - 1 ? '  →' : ''}
          </Text>
        )
      })
      const diags = (job.run?.diagnostics ?? []).filter(d => d.severity === 'error').slice(0, 8)
      output = (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={job.stage === 'failed' ? 'red' : job.stage === 'done' ? 'green' : 'yellow'} paddingX={1}>
          <Box columnGap={1} flexWrap="wrap">
            <Text bold>{clip(job.title, cols - 30)}</Text>
            <Text dimColor>{job.progress} · {job.requestedBy} · {clock((isRunning ? now : (job.run?.startedAt ?? now) + (job.run?.durationMs ?? 0)) - (isRunning ? job.startedAt : job.run?.startedAt ?? job.startedAt))}</Text>
            {isRunning && <Button key="cancel" label="Cancel" onPress={() => cancelJob($)} />}
          </Box>
          <Box columnGap={1} flexWrap="wrap">{chips}</Box>
          {job.stage === 'failed' && diags.length > 0 ? (
            <Box flexDirection="column">
              {diags.map((d, i) => (
                <Text key={`d-${i}`} color="red">
                  {clip(`${d.code} ${d.file ? `${d.file.split(/[\\/]/).pop()}(${d.line},${d.column})` : ''} ${d.message}`, cols - 6)}
                </Text>
              ))}
            </Box>
          ) : job.stage === 'failed' && job.run?.error ? (
            <Text color="red">{clip(job.run.error, cols - 6)}</Text>
          ) : null}
          {job.stage === 'failed' && job.run && (
            <Box columnGap={1} flexWrap="wrap">
              <Button key="ask" variant="primary" label="Ask agent to fix" onPress={() => askAgent($, job.run!)} />
              {job.run.missingSymbols && <Button key="sym" label="Download symbols" onPress={() => downloadSymbols($, job.run!)} />}
            </Box>
          )}
          {(isRunning || logOpen) &&
            job.lines.slice(-(isRunning ? 10 : 25)).map((l, i) => (
              <Text key={`l-${i}`} dimColor>
                {clip(l, cols - 6)}
              </Text>
            ))}
          {!isRunning && <Button key="log" plain dimColor label={logOpen ? '▾ hide output' : '▸ show output'} onPress={() => update($, showLog, (v: boolean) => !v)} />}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {appRows}
        {envBlock}
        {output}
        {errs.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {errs.map((er: { source: string; message: string }, i: number) => (
              <Text key={`e-${i}`} dimColor>
                {clip(`⚠ ${er.source}: ${er.message}`, cols - 2)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
