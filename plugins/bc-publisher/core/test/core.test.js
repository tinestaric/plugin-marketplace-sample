import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { orderByDependencies } from '../apps.js'
import { parseDiagnostics } from '../compile.js'
import { mergeEnvironments, parseContainers, parseLaunch, parseSaas } from '../envs.js'
import { appsToText, buildErrorPrompt, createPublisher, environmentsToText, publishBlock } from '../index.js'
import { publishArgs } from '../publish.js'
import { exec, parseJsonc } from '../util.js'

const fx = name => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const HOME = '/home/me'
const WS = '/ws'
const appJson = (id, name, deps = []) =>
  JSON.stringify({ id, name, publisher: 'Acme', version: '1.0.0.0', runtime: '14.0', idRanges: [{ from: 50000, to: 50099 }], dependencies: deps.map(d => ({ id: d, name: d, publisher: 'Acme', version: '1.0.0.0' })) })

const LAUNCH = `{
  // comments and trailing commas are normal in launch.json
  "version": "0.2.0",
  "configurations": [
    { "type": "al", "request": "launch", "name": "Local bc24", "server": "http://bc24-w1", "serverInstance": "BC", "port": 7049, "authentication": "UserPassword" },
    { "type": "al", "request": "launch", "name": "Customer A sandbox", "environmentType": "Sandbox", "environmentName": "dev", "tenant": "customera.onmicrosoft.com", "schemaUpdateMode": "ForceSync" },
    { "type": "al", "request": "launch", "name": "Customer A prod", "environmentType": "Production", "environmentName": "Production", "tenant": "customera.onmicrosoft.com" },
    { "type": "al", "request": "launch", "name": "Old box", "server": "http://onprem1", "serverInstance": "BC14", "port": 7149, "authentication": "Windows" },
    { "type": "node", "name": "ignored" },
  ],
}`

// a real BC image: maintainer "Dynamics SMB", `nav` label empty (as BC28/BC29 report)
const CONTAINERS_TSV = 'bc24-w1\trunning\tDynamics SMB\t\t24.3.0.1\tw1\nsqlserver\trunning\t\t\t\t\n'
const SAAS_JSON = JSON.stringify({
  value: [
    { name: 'dev', type: 'Sandbox', countryCode: 'DK', status: 'Active', versionDetails: { version: '26.1' } },
    { name: 'Production', type: 'Production', countryCode: 'DK', status: 'Active', versionDetails: { version: '26.1' } },
    { name: 'weird', type: 'Mystery', countryCode: 'DK', status: 'Active' },
  ],
})
const TENANT = { id: '11111111-1111-1111-1111-111111111111', label: 'Customer A', domain: 'customera.onmicrosoft.com' }

/** In-memory io. `script` answers spawned commands: (argv, init) -> { lines, code }. */
function fakeIo({ files = {}, script = () => ({ lines: [], code: 0 }), runs = {} } = {}) {
  const spawned = []
  const mtimes = {}
  return {
    home: HOME,
    now: (() => {
      let t = 1000
      return () => (t += 10)
    })(),
    spawned,
    files,
    mtimes,
    fs: {
      read: async p => {
        if (p in files) return files[p]
        throw new Error('ENOENT ' + p)
      },
      write: async (p, t) => void (files[p] = t),
      exists: async p => p in files || Object.keys(files).some(k => k.startsWith(p + '/')),
      stat: async p => {
        if (p in files) return { kind: 'file', mtimeMs: mtimes[p] ?? 1 }
        throw new Error('ENOENT ' + p)
      },
      list: async dir => {
        const prefix = dir.replace(/\/$/, '') + '/'
        const seen = new Map()
        for (const k of Object.keys(files)) {
          if (!k.startsWith(prefix)) continue
          const [first, ...more] = k.slice(prefix.length).split('/')
          seen.set(first, more.length ? 'dir' : 'file')
        }
        if (!seen.size) throw new Error('ENOENT ' + dir)
        return [...seen].map(([name, kind]) => ({ name, kind, mtimeMs: mtimes[prefix + name] ?? 1 }))
      },
    },
    run: async argv => {
      const cmd = argv.join(' ')
      for (const [re, out] of Object.entries(runs)) if (new RegExp(re).test(cmd)) return { exitCode: 0, stderr: '', ...out }
      return { exitCode: 1, stdout: '', stderr: 'not available' }
    },
    fetch: async url => (/environments$/.test(url) ? { status: 200, ok: true, text: SAAS_JSON } : { status: 404, ok: false, text: '' }),
    spawn(argv, init) {
      spawned.push({ argv, init })
      const { lines, code } = script(argv, init)
      let i = 0
      let stopped = false
      return {
        async next() {
          if (stopped || i >= lines.length) return { done: true, value: { code: stopped ? null : code, signal: null } }
          return { done: false, value: { stream: 'stdout', text: lines[i++] + '\n' } }
        },
        async return() {
          stopped = true
          return { done: true, value: { code: null, signal: null } }
        },
      }
    },
  }
}

const EXT = `${HOME}/.vscode/extensions/ms-dynamics-smb.al-15.0.1`

function workspace(extra = {}, config = {}) {
  return {
    [`${WS}/base/app.json`]: appJson('b', 'Base'),
    [`${WS}/base/.alpackages/Microsoft_Base.app`]: 'x',
    [`${WS}/base/src/Thing.al`]: 'codeunit 50000 Thing {}',
    [`${WS}/ext/app.json`]: appJson('e', 'Ext', ['b']),
    [`${WS}/ext/.vscode/launch.json`]: LAUNCH,
    [`${WS}/ext/.alpackages/Microsoft_Base.app`]: 'x',
    [`${WS}/node_modules/skip/app.json`]: appJson('n', 'Skipped'),
    [`${WS}/base/.alpackages/app.json`]: appJson('p', 'AlsoSkipped'),
    [`${EXT}/bin/win32/alc.exe`]: 'exe',
    [`${HOME}/.bc-publisher/config.json`]: JSON.stringify({ tenants: [TENANT], environments: [{ id: 'container:bc24-w1', agentMayPublish: true }], ...config }),
    ...extra,
  }
}

const RUNS = {
  '^al --version': { stdout: '18.0.41+abc\n' },
  'docker ps': { stdout: CONTAINERS_TSV },
  'get-access-token': { stdout: 'tok\n' },
}
const isCompile = argv => argv[1] === 'compile' || /alc\.exe$/.test(argv[0])
const okScript = argv => (isCompile(argv) ? { lines: ['Compiled'], code: 0 } : { lines: ['Published'], code: 0 })

// ── discovery ─────────────────────────────────────────────────────────────

test('discoverApps finds app.json files, skips .alpackages and node_modules, orders base first', async () => {
  const p = createPublisher(fakeIo({ files: workspace() }), { workspaceRoot: WS })
  const apps = await p.discoverApps()
  assert.deepEqual(apps.map(a => a.name), ['Base', 'Ext'])
  assert.deepEqual(apps[1].dependsOn, ['Base'])
  assert.deepEqual(apps[0].idRanges, [{ from: 50000, to: 50099 }])
  assert.match(appsToText(apps), /Ext 1\.0\.0\.0 .*← Base/)
})

test('discoverApps honours a .code-workspace file', async () => {
  const files = workspace({ [`${WS}/x.code-workspace`]: '{ "folders": [ { "path": "ext" } ], // c\n }' })
  const apps = await createPublisher(fakeIo({ files }), { workspaceRoot: WS }).discoverApps()
  assert.deepEqual(apps.map(a => a.name), ['Ext'])
})

test('dependency order is stable and cycle-safe', () => {
  const mk = (id, deps) => ({ id, name: id, dependencies: deps.map(d => ({ id: d })) })
  assert.deepEqual(orderByDependencies([mk('c', ['b']), mk('b', ['a']), mk('a', [])]).map(a => a.id), ['a', 'b', 'c'])
  assert.equal(orderByDependencies([mk('x', ['y']), mk('y', ['x'])]).length, 2)
})

test('parseJsonc handles comments, trailing commas and urls in strings', () => {
  assert.deepEqual(parseJsonc('{ "u": "http://a//b", /* c */ "n": [1,2,], }'), { u: 'http://a//b', n: [1, 2] })
})

test('launch.json yields server, sandbox and production targets with their connection settings', () => {
  const l = parseLaunch(LAUNCH, 'launch.json')
  assert.deepEqual(l.map(e => [e.kind, e.isProduction]), [['onprem', false], ['saas', false], ['saas', true], ['onprem', false]])
  assert.equal(l[1].schemaUpdateMode, 'ForceSync')
  assert.deepEqual(l[3].details, { server: 'http://onprem1', serverInstance: 'BC14', port: 7149, tenant: 'default', authentication: 'Windows' })
})

test('containers come from docker labels, not BcContainerHelper', () => {
  const c = parseContainers(CONTAINERS_TSV)
  assert.deepEqual(c.map(x => x.id), ['container:bc24-w1'], 'a container without a nav label is not a BC container')
  assert.deepEqual(c[0].details, { name: 'bc24-w1', bcVersion: '24.3.0.1', country: 'w1', state: 'running', server: 'http://bc24-w1', serverInstance: 'BC', port: 7049, authentication: 'UserPassword', tenant: 'default' })
})

test('environments merge launch.json, containers and SaaS into one list with production flagged', async () => {
  const p = createPublisher(fakeIo({ files: workspace(), runs: RUNS }), { workspaceRoot: WS })
  const envs = await p.discoverEnvironments()
  const byId = Object.fromEntries(envs.map(e => [e.id, e]))

  const container = byId['container:bc24-w1']
  assert.equal(container.kind, 'container', 'launch.json server that is a container folds into it')
  assert.deepEqual(container.sources.sort(), ['docker', 'launch.json'])
  assert.equal(container.details.bcVersion, '24.3.0.1')
  assert.equal(container.agentMayPublish, true)

  const sandbox = byId[`saas:${TENANT.id}/dev`]
  assert.equal(sandbox.isProduction, false)
  assert.equal(sandbox.schemaUpdateMode, 'ForceSync', 'launch.json domain tenant folded onto the configured tenant id')
  assert.ok(sandbox.sources.includes('launch.json') && sandbox.sources.includes('admin-center'))

  assert.equal(byId[`saas:${TENANT.id}/production`].isProduction, true)
  assert.equal(byId[`saas:${TENANT.id}/weird`].isProduction, true, 'undeterminable type is treated as production')
  assert.equal(byId['onprem:onprem1:7149/bc14'].kind, 'onprem')
  assert.equal(envs.at(-1).isProduction, true, 'production listed last')
  assert.match(environmentsToText(envs), /PRODUCTION: read-only/)
})

test('a config entry can only make a target safer: isProduction: true', async () => {
  const files = workspace({}, { environments: [{ id: 'container:bc24-w1', isProduction: true, agentMayPublish: true }] })
  const envs = await createPublisher(fakeIo({ files, runs: RUNS }), { workspaceRoot: WS }).discoverEnvironments()
  assert.equal(envs.find(e => e.id === 'container:bc24-w1').isProduction, true)
})

test('one failing source does not hide the others', async () => {
  const io = fakeIo({ files: workspace(), runs: { 'get-access-token': { stdout: 'tok' } } })
  const p = createPublisher(io, { workspaceRoot: WS })
  const envs = await p.discoverEnvironments()
  assert.ok(envs.some(e => e.kind === 'saas'))
  assert.ok(p.errors.some(e => e.source === 'containers'))
})

test('parseSaas shapes the entries', () => {
  const s = parseSaas(JSON.parse(SAAS_JSON), TENANT)
  assert.deepEqual(s.map(e => e.isProduction), [false, true, true])
  assert.equal(s[0].details.country, 'DK')
})

// ── compile ───────────────────────────────────────────────────────────────

test('parseDiagnostics extracts severity, code, file, line, column and message', () => {
  const d = parseDiagnostics([
    'Compiling...',
    "C:\\ws\\ext\\src\\Sales.al(12,5): error AL0118: The name 'Foo' does not exist [C:\\ws\\ext\\app.json]",
    'C:\\ws\\ext\\src\\Sales.al(30,1): warning AL0432: Obsolete thing',
    'error AL1022: The dependent package could not be found',
  ])
  assert.deepEqual(d[0], { severity: 'error', code: 'AL0118', file: 'C:\\ws\\ext\\src\\Sales.al', line: 12, column: 5, message: "The name 'Foo' does not exist" })
  assert.equal(d[1].severity, 'warning')
  assert.deepEqual([d[2].file, d[2].line], [null, null])
})

test('real `altool compile` output: missing symbols are AL1022, not a guess', async () => {
  const lines = fx('altool-compile-missing-symbols.txt').split(/\r?\n/)
  const d = parseDiagnostics(lines)
  assert.deepEqual(d.map(x => x.code), ['AL1022', 'AL1022'])
  const io = fakeIo({ files: workspace(), runs: RUNS, script: () => ({ lines, code: 1 }) })
  const r = await createPublisher(io, { workspaceRoot: WS }).compileApp(`${WS}/base`)
  assert.equal(r.ok, false)
  assert.equal(r.missingSymbols, true)
})

test('compileApp runs `altool compile` with the project, package cache and out path', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: () => ({ lines: ['Compiled'], code: 0 }) })
  const lines = []
  const r = await createPublisher(io, { workspaceRoot: WS }).compileApp(`${WS}/base`, { onOutput: l => lines.push(l) })
  assert.equal(r.ok, true)
  assert.deepEqual(r.compiler, { label: 'altool', version: '18.0.41' })
  const argv = io.spawned[0].argv
  assert.deepEqual(argv.slice(0, 2), ['al', 'compile'])
  assert.ok(argv.includes(`/project:${WS}/base`))
  assert.ok(argv.includes(`/packagecachepath:${WS}/base/.alpackages`))
  assert.ok(argv.includes(`/out:${WS}/base/Acme_Base_1.0.0.0.app`))
  assert.ok(lines.includes('Compiled'), 'output is streamed as it arrives')
})

test('without altool the AL extension\'s alc.exe still compiles', async () => {
  const io = fakeIo({ files: workspace(), runs: { 'get-access-token': { stdout: 'tok' } }, script: okScript })
  const r = await createPublisher(io, { workspaceRoot: WS }).compileApp(`${WS}/base`)
  assert.equal(r.ok, true)
  assert.equal(r.compiler.label, 'alc')
  assert.equal(io.spawned[0].argv[0], `${EXT}/bin/win32/alc.exe`)
})

test('a broken app compiles to parsed errors', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: () => ({ lines: [`${WS}/ext/src/A.al(3,1): error AL0104: Syntax error`], code: 1 }) })
  const r = await createPublisher(io, { workspaceRoot: WS }).compileApp(`${WS}/ext`)
  assert.equal(r.ok, false)
  assert.equal(r.diagnostics[0].code, 'AL0104')
  assert.equal(r.missingSymbols, false)
})

test('ruleset and analysers from .vscode/settings.json are passed to the compiler', async () => {
  const files = workspace({
    [`${WS}/base/.vscode/settings.json`]: '{ "al.ruleSetPath": "my.ruleset.json", "al.enableCodeAnalysis": true, "al.codeAnalyzers": ["${CodeCop}"] }',
    [`${EXT}/bin/Analyzers/Microsoft.Dynamics.Nav.CodeCop.dll`]: 'dll',
  })
  const io = fakeIo({ files, runs: RUNS })
  await createPublisher(io, { workspaceRoot: WS }).compileApp(`${WS}/base`)
  const argv = io.spawned[0].argv
  assert.ok(argv.includes(`/ruleset:${WS}/base/my.ruleset.json`))
  assert.ok(argv.some(a => a.startsWith('/analyzer:') && a.endsWith('CodeCop.dll')))
})

test('no AL tool and no extension: a clear error with the install command', async () => {
  const files = workspace()
  delete files[`${EXT}/bin/win32/alc.exe`]
  const r = await createPublisher(fakeIo({ files }), { workspaceRoot: WS }).compileApp(`${WS}/base`)
  assert.equal(r.ok, false)
  assert.match(r.error, /dotnet tool install -g Microsoft\.Dynamics\.BusinessCentral\.Development\.Tools/)
})

// ── publish ───────────────────────────────────────────────────────────────

test('publish to a container compiles then runs `altool publishapp` against its server, and records the run', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: okScript })
  const p = createPublisher(io, { workspaceRoot: WS })
  const stages = []
  const run = await p.publishApp(`${WS}/base`, 'container:bc24-w1', { onStage: s => stages.push(s) })

  assert.equal(run.ok, true)
  assert.deepEqual(stages, ['queued', 'compiling', 'publishing', 'done'])
  const argv = io.spawned.at(-1).argv
  assert.deepEqual(argv.slice(0, 3), ['al', 'publishapp', `${WS}/base/Acme_Base_1.0.0.0.app`])
  const pair = flag => argv[argv.indexOf(flag) + 1]
  assert.equal(pair('--server'), 'http://bc24-w1')
  assert.equal(pair('--serverinstance'), 'BC')
  assert.equal(pair('--port'), '7049')
  assert.equal(pair('--environmenttype'), 'OnPrem')
  assert.equal(pair('--authentication'), 'UserPassword')
  assert.equal(pair('--schemaupdatemode'), 'Synchronize')
  assert.ok(!argv.some(a => /^--(user|pass)|BC_SERVER_/i.test(a)), 'credentials never travel on the command line')
  assert.equal(io.spawned.at(-1).init?.env, undefined, 'and are never injected: altool reads BC_SERVER_USERNAME/PASSWORD from the environment itself')
  assert.equal((await p.getLastRun('container:bc24-w1')).id, run.id)
  assert.equal(JSON.parse(io.files[`${HOME}/.bc-publisher/runs.json`])[0].appName, 'Base')
})

test('the chosen sync mode maps onto altool\'s schema update mode', () => {
  const env = { kind: 'container', details: { server: 'http://c', serverInstance: 'BC' } }
  assert.ok(publishArgs(env, 'a.app', 'ForceSync').join(' ').includes('--schemaupdatemode ForceSync'))
  assert.ok(publishArgs(env, 'a.app', 'Add').join(' ').includes('--schemaupdatemode Synchronize'))
  assert.ok(!publishArgs(env, 'a.app').includes('--port'), 'no port flag unless known')
})

test('a compile error stops the publish and the run holds the parsed diagnostics', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: () => ({ lines: ['/ws/base/src/Thing.al(1,1): error AL0104: Syntax error'], code: 1 }) })
  const run = await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, 'container:bc24-w1')
  assert.equal(run.ok, false)
  assert.equal(run.stage, 'compiling')
  assert.equal(run.diagnostics[0].code, 'AL0104')
  assert.equal(io.spawned.length, 1, 'nothing was published')

  const prompt = buildErrorPrompt(run)
  assert.match(prompt, /Thing\.al\(1,1\): error AL0104/)
  assert.match(prompt, /mcp__bc-publisher__publisher_publish/)
  assert.match(prompt, /container:bc24-w1/)
  assert.match(prompt, /Do not run Publish-BcContainerApp/)
})

test('production and undeterminable targets are refused, with a recorded run and nothing spawned', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: okScript })
  const p = createPublisher(io, { workspaceRoot: WS })
  for (const id of [`saas:${TENANT.id}/production`, `saas:${TENANT.id}/weird`]) {
    const run = await p.publishApp(`${WS}/base`, id)
    assert.equal(run.ok, false)
    assert.equal(run.stage, 'blocked')
    assert.match(run.error, /production|could not be determined/)
  }
  assert.equal(io.spawned.length, 0)
  assert.match(publishBlock(null), /Unknown/)
  assert.match(publishBlock({ label: 'x', kind: 'container', isProduction: false, details: { server: "http://a'; rm" } }), /no usable server URL/)
})

test('an on-prem server needs allowPublish, then publishes with its own server, instance, port and auth', async () => {
  const id = 'onprem:onprem1:7149/bc14'
  const io = fakeIo({ files: workspace(), runs: RUNS, script: okScript })
  const blocked = await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, id)
  assert.equal(blocked.stage, 'blocked')
  assert.match(blocked.error, /"allowPublish": true/)
  assert.equal(io.spawned.length, 0)

  const allowed = fakeIo({ files: workspace({}, { environments: [{ id, allowPublish: true }] }), runs: RUNS, script: okScript })
  const run = await createPublisher(allowed, { workspaceRoot: WS }).publishApp(`${WS}/base`, id)
  assert.equal(run.ok, true)
  const argv = allowed.spawned.at(-1).argv
  const pair = flag => argv[argv.indexOf(flag) + 1]
  assert.deepEqual([pair('--server'), pair('--serverinstance'), pair('--port'), pair('--authentication')], ['http://onprem1', 'BC14', '7149', 'Windows'])
})

test('SaaS sandbox publish uses altool\'s own login: environment flags only, no token handling', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: okScript })
  const run = await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, `saas:${TENANT.id}/dev`)
  assert.equal(run.ok, true)
  const argv = io.spawned.at(-1).argv
  const pair = flag => argv[argv.indexOf(flag) + 1]
  assert.deepEqual([argv[0], argv[1]], ['al', 'publishapp'])
  assert.deepEqual([pair('--environmenttype'), pair('--environmentname'), pair('--tenant')], ['Sandbox', 'dev', TENANT.id])
  assert.equal(pair('--schemaupdatemode'), 'ForceSync', 'from launch.json')
  assert.ok(!argv.includes('--server'))
  assert.ok(!io.spawned.some(s => s.init?.input), 'nothing is piped in')
})

test('a rejected login is explained with the command that fixes it', async () => {
  const fail = argv => (isCompile(argv) ? { lines: ['Compiled'], code: 0 } : { lines: ['UserNotAuthenticatedException', "Publish failed: Authentication required for method 'AAD'. Run 'altool auth login'"], code: 1 })
  const io = fakeIo({ files: workspace(), runs: RUNS, script: fail })
  const run = await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, `saas:${TENANT.id}/dev`)
  assert.equal(run.ok, false)
  assert.match(run.error, /al auth login/)

  const io2 = fakeIo({ files: workspace(), runs: RUNS, script: fail })
  const run2 = await createPublisher(io2, { workspaceRoot: WS }).publishApp(`${WS}/base`, 'container:bc24-w1')
  assert.match(run2.error, /BC_SERVER_USERNAME/)
})

test('cancelling a job kills the child and reports cancelled', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: () => ({ lines: ['a', 'b', 'c'], code: 0 }) })
  const handle = {}
  const run = await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, 'container:bc24-w1', {
    handle,
    onOutput: l => l === 'a' && handle.cancel(),
  })
  assert.equal(run.ok, false)
  assert.match(run.error, /cancelled/)
})

test('skipCompile reuses a built .app that is newer than every source', async () => {
  const app = `${WS}/base/Acme_Base_1.0.0.0.app`
  const io = fakeIo({ files: workspace({ [app]: 'bin' }), runs: RUNS, script: okScript })
  io.mtimes[app] = 500
  const run = await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, 'container:bc24-w1', { skipCompile: true })
  assert.equal(run.ok, true)
  assert.ok(!io.spawned.some(s => isCompile(s.argv)))

  io.mtimes[`${WS}/base/src/Thing.al`] = 900 // edited after the build
  await createPublisher(io, { workspaceRoot: WS }).publishApp(`${WS}/base`, 'container:bc24-w1', { skipCompile: true })
  assert.ok(io.spawned.some(s => isCompile(s.argv)), 'stale .app is recompiled')
})

test('runs.json keeps the last 50', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: okScript })
  const p = createPublisher(io, { workspaceRoot: WS })
  for (let i = 0; i < 53; i++) await p.publishApp(`${WS}/base`, `saas:${TENANT.id}/production`)
  assert.equal(JSON.parse(io.files[`${HOME}/.bc-publisher/runs.json`]).length, 50)
})

test('exec streams complete lines even when chunks split them', async () => {
  const io = fakeIo({})
  io.spawn = () => {
    const chunks = ['hel', 'lo\nwor', 'ld']
    let i = 0
    return { next: async () => (i < 3 ? { done: false, value: { stream: 'stdout', text: chunks[i++] } } : { done: true, value: { code: 0 } }) }
  }
  const seen = []
  const r = await exec(io, ['x'], { onOutput: l => seen.push(l) })
  assert.deepEqual(seen, ['hello', 'world'])
  assert.equal(r.code, 0)
})

test('mergeEnvironments is a pure fold: the same target from two sources appears once', () => {
  const c = parseContainers(CONTAINERS_TSV)
  const l = parseLaunch(LAUNCH, 'launch.json').slice(0, 1)
  const merged = mergeEnvironments(l, c, [], [])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].details.port, 7049)
})

test('diagnostics the compiler prints relative to the project are made absolute', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS, script: () => ({ lines: ['src\Thing.al(13,9): error AL0118: The name \'Foo\' does not exist in the current context.'], code: 1 }) })
  const r = await createPublisher(io, { workspaceRoot: WS }).compileApp(`${WS}/base`)
  assert.equal(r.diagnostics[0].file, `${WS}/base/src\Thing.al`)
  assert.deepEqual([r.diagnostics[0].line, r.diagnostics[0].column], [13, 9])
})

test('symbol download follows package dependencies; credentials go to curl on stdin only', async () => {
  const files = workspace({ [`${WS}/ext/app.json`]: JSON.stringify({ id: 'e', name: 'Ext', publisher: 'Acme', version: '1.0.0.0', platform: '28.0.0.0', application: '28.0.0.0', dependencies: [] }) })
  const io = fakeIo({
    files,
    runs: { ...RUNS, 'GetPackageManifest .*Application_': { stdout: JSON.stringify({ dependencies: [{ publisher: 'Microsoft', name: 'Base Application', version: '28.0.0.0' }, { publisher: 'Microsoft', name: 'System', version: '28.0.0.0' }] }) }, GetPackageManifest: { stdout: '{"dependencies":[]}' } },
    script: () => ({ lines: [], code: 0 }),
  })
  io.credentials = async () => ({ user: 'admin', password: 's3cret' })
  const lines = []
  const r = await createPublisher(io, { workspaceRoot: WS }).downloadSymbols(`${WS}/ext`, 'container:bc24-w1', { onOutput: l => lines.push(l) })

  assert.equal(r.ok, true)
  assert.deepEqual(r.downloaded.map(d => d.name), ['System', 'Application', 'Base Application'], 'System is not fetched twice; Base Application came from the manifest')
  const curls = io.spawned.filter(s => s.argv[0] === 'curl.exe')
  assert.equal(curls.length, 3)
  assert.match(curls[0].init.input, /url = "http:\/\/bc24-w1:7049\/BC\/dev\/packages\?publisher=Microsoft&appName=System&versionText=28\.0\.0\.0&tenant=default"/)
  assert.match(curls[0].init.input, /user = "admin:s3cret"/)
  assert.ok(!curls.some(c => c.argv.join(' ').includes('s3cret')), 'the password is never an argument')
  assert.ok(!lines.join('\n').includes('s3cret'), 'nor in the output')
})

test('symbol download refuses SaaS, production, and missing credentials', async () => {
  const io = fakeIo({ files: workspace(), runs: RUNS })
  const p = createPublisher(io, { workspaceRoot: WS })
  await assert.rejects(p.downloadSymbols(`${WS}/base`, `saas:${TENANT.id}/dev`), /container or an allowed on-prem/)
  await assert.rejects(p.downloadSymbols(`${WS}/base`, `saas:${TENANT.id}/production`), /production/i)
  io.credentials = async () => ({})
  await assert.rejects(p.downloadSymbols(`${WS}/base`, 'container:bc24-w1'), /BC_SERVER_USERNAME/)
  assert.equal(io.spawned.length, 0)
})

test('a runs.json in another tool\'s format is never overwritten', async () => {
  const foreign = JSON.stringify({ format: 'bc-publisher-runs', version: 1, runs: [{ id: 'theirs' }] })
  const io = fakeIo({ files: workspace({ [`${HOME}/.bc-publisher/runs.json`]: foreign }), runs: RUNS, script: okScript })
  const p = createPublisher(io, { workspaceRoot: WS })
  await p.publishApp(`${WS}/base`, `saas:${TENANT.id}/production`)
  assert.equal(io.files[`${HOME}/.bc-publisher/runs.json`], foreign, 'their file is untouched')
  assert.equal(JSON.parse(io.files[`${HOME}/.bc-publisher/runs.altool.json`]).length, 1, 'ours goes beside it')
  assert.equal((await p.getLastRun(`saas:${TENANT.id}/production`)).stage, 'blocked')
})

test('the first-run example config grants nothing', async () => {
  const io = fakeIo({ files: {} })
  const p = createPublisher(io, { workspaceRoot: WS })
  await p.loadConfig()
  const written = JSON.parse(io.files[`${HOME}/.bc-publisher/config.json`])
  assert.ok(written.environments.every(e => !e.agentMayPublish && !e.allowPublish))
})

test('on Windows az is az.cmd: when it cannot be spawned directly, cmd.exe /c az is used', async () => {
  const io = fakeIo({ files: workspace(), runs: {} })
  io.run = async argv => {
    if (argv[0] === 'cmd.exe') return { exitCode: 0, stdout: 'tok\n', stderr: '' }
    throw new Error('spawn ' + argv[0] + ' ENOENT/EINVAL')
  }
  const { bcToken } = await import('../envs.js')
  assert.equal(await bcToken(io, TENANT.id), 'tok')
})

test('a SaaS sandbox that is not ready (e.g. CreatingFailed) is not a publish target', () => {
  const env = { label: 'Customer A · Preview', kind: 'saas', type: 'Sandbox', isProduction: false, details: { state: 'CreatingFailed' } }
  assert.match(publishBlock(env), /not ready \(status: CreatingFailed\)/)
  assert.equal(publishBlock({ ...env, details: { state: 'ready' } }), null)
  assert.equal(publishBlock({ ...env, details: {} }), null, 'launch.json-only targets have no status to check')
})

test('a config.json with comments and environments keyed by id (written by another tool) still loads', async () => {
  const text = '// BC Publisher configuration\n{\n  "tenants": [ { "id": "t", "label": "L" } ], // c\n  "environments": { "container:bc24-w1": { "agentMayPublish": true } }\n}'
  const io = fakeIo({ files: { [`${HOME}/.bc-publisher/config.json`]: text } })
  const c = await createPublisher(io, { workspaceRoot: WS }).loadConfig()
  assert.deepEqual(c.environments, [{ id: 'container:bc24-w1', agentMayPublish: true }])
  assert.equal(c.tenants[0].id, 't')
})

// ── from the pull request review ───────────────────────────────────────────

test('the same server on another port or tenant is another target, with its own permissions', () => {
  const profile = (name, extra) => ({ type: 'al', request: 'launch', name, server: 'http://box', serverInstance: 'BC', authentication: 'Windows', ...extra })
  const launch = parseLaunch(JSON.stringify({ configurations: [profile('A', { port: 7049 }), profile('B', { port: 7149 }), profile('C', { port: 7049, tenant: 'other' })] }), 'launch.json')
  assert.deepEqual(launch.map(l => l.id), ['onprem:box:7049/bc', 'onprem:box:7149/bc', 'onprem:box:7049/bc?other'])
  assert.equal(new Set(launch.map(l => l.id)).size, 3)
  assert.equal(mergeEnvironments(launch, [], [], []).length, 3, 'none is folded into another')
})

test('a launch profile on a container host but another endpoint does not become the container', () => {
  const containers = parseContainers(CONTAINERS_TSV)
  const profile = extra => parseLaunch(JSON.stringify({ configurations: [{ type: 'al', name: 'p', server: 'http://bc24-w1', serverInstance: 'BC', authentication: 'UserPassword', ...extra }] }), 'launch.json')
  const own = mergeEnvironments(profile({ port: 7049 }), containers, [], [])
  assert.deepEqual(own.map(e => e.id), ['container:bc24-w1'])
  const other = mergeEnvironments(profile({ port: 7149 }), containers, [], [])
  assert.deepEqual(other.map(e => e.id).sort(), ['container:bc24-w1', 'onprem:bc24-w1:7149/bc'])
  assert.equal(other.find(e => e.kind === 'container').details.port, 7049, 'the container keeps its own connection details')
})

test('an unreadable config fails closed: no targets, nothing published, and it recovers when fixed', async () => {
  const files = workspace({ [`${HOME}/.bc-publisher/config.json`]: '{ "environments": [ { "id": "container:bc24-w1", "isProduction": true ' })
  const io = fakeIo({ files, runs: RUNS, script: okScript })
  const p = createPublisher(io, { workspaceRoot: WS })
  assert.deepEqual(await p.discoverEnvironments(), [])
  assert.ok(p.errors.some(e => e.source === 'config' && e.message.includes('No targets are offered')))

  const run = await p.publishApp(`${WS}/base`, 'container:bc24-w1')
  assert.equal(run.stage, 'blocked')
  assert.equal(io.spawned.length, 0, 'the broken config did not turn a production container into a publish target')

  io.files[`${HOME}/.bc-publisher/config.json`] = JSON.stringify({ environments: [{ id: 'container:bc24-w1', isProduction: true }] })
  assert.equal((await p.publishApp(`${WS}/base`, 'container:bc24-w1')).error.includes('production'), true, 'the fixed config is read again, restriction intact')
})

test('the fix prompt carries the error of a run that produced no diagnostics or output', () => {
  const prompt = buildErrorPrompt({ appName: 'Base', appVersion: '1.0.0.0', environmentId: 'container:x', environmentLabel: 'x', stage: 'compiling', diagnostics: [], tail: [], error: 'No AL compiler found. Install the AL tool: dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools' })
  assert.ok(prompt.includes('dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools'))
  assert.ok(!prompt.includes('(no output captured)'))
})

test('a cancelled symbol download is a failure, not a success', async () => {
  const files = workspace({ [`${WS}/ext/app.json`]: JSON.stringify({ id: 'e', name: 'Ext', publisher: 'Acme', version: '1.0.0.0', platform: '28.0.0.0', application: '28.0.0.0' }) })
  const io = fakeIo({ files, runs: { ...RUNS, GetPackageManifest: { stdout: '{"dependencies":[]}' } }, script: () => ({ lines: [], code: 0 }) })
  io.credentials = async () => ({ user: 'admin', password: 'pw' })
  const handle = {}
  const spawn = io.spawn.bind(io)
  let curls = 0
  io.spawn = (argv, init) => {
    const it = spawn(argv, init)
    if (argv[0] !== 'curl.exe' || ++curls < 2) return it
    return { next: async () => (await handle.cancel(), { done: true, value: { code: null, signal: null } }), return: async () => ({ done: true, value: {} }) }
  }
  const r = await createPublisher(io, { workspaceRoot: WS }).downloadSymbols(`${WS}/ext`, 'container:bc24-w1', { handle })
  assert.equal(r.ok, false)
  assert.ok(r.downloaded.length >= 1 && r.failed.some(f => f.error === 'cancelled'))
})
