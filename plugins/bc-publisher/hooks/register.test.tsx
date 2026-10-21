import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/me'
const WS = '/ws'
const APP = `${WS}/base`
const TENANT = '11111111-1111-1111-1111-111111111111'

const PANE = {
  plugin: 'bc-publisher',
  component: 'Pane',
  requestId: 'publisher',
  props: { title: 'Publisher', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = {
  plugin: 'bc-publisher',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').split('\\').join('/')

type World = { spawned: { argv: string[]; input?: string }[]; submitted: string[]; files: Record<string, string> }

/**
 * A workspace with one app, a running container (agentMayPublish configurable), a SaaS sandbox and production.
 * `compileOutput` is what `altool compile` prints; `compileCode` its exit status.
 */
function world(on: any, opts: { agentMayPublish?: boolean; compileOutput?: string; compileCode?: number; ask?: string; isPlaced?: boolean; forceSyncLaunch?: boolean } = {}): World {
  const w: World = { spawned: [], submitted: [], files: {} }
  const { agentMayPublish = true, compileOutput = 'Compiled', compileCode = 0, ask = 'Publish', isPlaced = true, forceSyncLaunch = false } = opts
  w.files = {
    [`${APP}/app.json`]: JSON.stringify({ id: 'b', name: 'Base', publisher: 'Acme', version: '1.0.0.0', dependencies: [] }),
    [`${APP}/.alpackages/x.app`]: 'x',
    [`${HOME}/.bc-publisher/config.json`]: JSON.stringify({ tenants: [{ id: TENANT, label: 'Customer A' }], environments: agentMayPublish ? [{ id: 'container:bc24-w1', agentMayPublish: true }] : [] }),
    ...(forceSyncLaunch
      ? { [`${APP}/.vscode/launch.json`]: JSON.stringify({ configurations: [{ type: 'al', name: 'c', server: 'http://bc24-w1', serverInstance: 'BC', port: 7049, authentication: 'UserPassword', schemaUpdateMode: 'ForceSync' }] }) }
      : {}),
  }
  mock.clock(on)
  mock.env(on, { USERPROFILE: HOME })
  on('command.register', () => ({ value: { command: 'publish' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced } }))
  on('fs.exists', (_: any, e: any) => ({ value: norm(e.path) in w.files || Object.keys(w.files).some(k => k.startsWith(norm(e.path) + '/')) }))
  on('fs.read', (_: any, e: any) => {
    if (!(norm(e.path) in w.files)) throw new Error('ENOENT ' + e.path)
    return { value: w.files[norm(e.path)] }
  })
  on('fs.write', (_: any, e: any) => ((w.files[norm(e.path)] = e.text), { value: undefined }))
  on('fs.stat', (_: any, e: any) => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.list', (_: any, e: any) => {
    const prefix = norm(e.path).replace(/\/$/, '') + '/'
    const seen = new Map<string, string>()
    for (const k of Object.keys(w.files)) {
      if (!k.startsWith(prefix)) continue
      const [first, ...more] = k.slice(prefix.length).split('/')
      seen.set(first, more.length ? 'dir' : 'file')
    }
    if (!seen.size) throw new Error('ENOENT ' + e.path)
    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('process.run', (_: any, e: any) => {
    const cmd = (e.argv as string[]).join(' ')
    if (/--version/.test(cmd)) return { value: { exitCode: 0, stdout: '18.0.41+abc\n', stderr: '' } }
    if (/^docker ps/.test(cmd)) return { value: { exitCode: 0, stdout: 'bc24-w1\trunning\tDynamics SMB\t\t24.3.0.1\tw1\n', stderr: '' } }
    if (/get-access-token/.test(cmd)) return { value: { exitCode: 0, stdout: 'tok\n', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'not available' } }
  })
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ value: [{ name: 'dev', type: 'Sandbox', countryCode: 'DK', status: 'Active' }, { name: 'Production', type: 'Production', countryCode: 'DK', status: 'Active' }] }),
    },
  }))
  on('process.spawn', async function* (_: any, e: any) {
    w.spawned.push({ argv: e.argv, input: e.input })
    const isAlc = e.argv[1] === 'compile'
    yield { stream: 'stdout', text: (isAlc ? compileOutput : 'Published') + '\n' }
    return { value: { code: isAlc ? compileCode : 0, signal: null } }
  })
  on('prompt.submit', (_: any, e: any) => (w.submitted.push(e.text), { text: e.text }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: { answers: { [e.questions?.[0]?.question ?? 'q']: ask } } }))
  return w
}

const start = async ($: any) => {
  await $.session.start({ cwd: WS, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'publish', args: 'refresh' })
}
const call = ($: any, name: string, input: object) => $.tool.call({ tool: `mcp__bc-publisher__publisher_${name}`, ...input, input })

test('the pane shows apps and environments, and production has no publish button', async ($, on) => {
  world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Apps/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Local containers/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /SaaS sandboxes/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Production \(read-only\)/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'pub-container:bc24-w1' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `pub-saas:${TENANT}/dev` })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `pub-saas:${TENANT}/production` })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /publishing to production is not possible/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the agent publishes to a container that allows it, through the same code path as the buttons', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const called: any = await call($, 'publish', { appPath: 'Base', environmentId: 'container:bc24-w1' })
  const run = JSON.parse(called.result.content[0].text)
  expect(run.ok).toBe(true)
  expect(run.requestedBy).toBe('agent')
  expect(w.spawned.map(s => s.argv.slice(0, 2).join(' '))).toEqual(['al compile', 'al publishapp'])
  expect(w.spawned[1].argv).toContain('http://bc24-w1')

  // the UI shows the run the agent triggered
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /agent/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /last: Base 1\.0\.0\.0/ })).toBeTruthy()
  await ui.unmount()

  const last: any = await call($, 'last_run', { environmentId: 'container:bc24-w1' })
  expect(JSON.parse(last.result.content[0].text).id).toBe(run.id)
})

test('the agent may not publish to a container without agentMayPublish, and nothing runs', async ($, on) => {
  const w = world(on, { agentMayPublish: false })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const called: any = await call($, 'publish', { appPath: 'Base', environmentId: 'container:bc24-w1' })
  expect(called.result.isError).toBe(true)
  expect(called.result.content[0].text).toMatch(/agentMayPublish/)
  expect(w.spawned.length).toBe(0)
})

test('production and undeterminable targets are refused for the agent', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const called: any = await call($, 'publish', { appPath: 'Base', environmentId: `saas:${TENANT}/production` })
  expect(called.result.isError).toBe(true)
  expect(called.result.content[0].text).toMatch(/production/i)
  expect(w.spawned.length).toBe(0)

  const envs: any = await call($, 'list_environments', {})
  const list = JSON.parse(envs.result.content[0].text)
  expect(list.find((e: any) => e.id === `saas:${TENANT}/production`).isProduction).toBe(true)
})

test('a SaaS sandbox publish asks the person; declining runs nothing', async ($, on) => {
  const w = world(on, { ask: 'Cancel' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const called: any = await call($, 'publish', { appPath: 'Base', environmentId: `saas:${TENANT}/dev` })
  expect(called.result.isError).toBe(true)
  expect(w.spawned.length).toBe(0)
})

test('a SaaS sandbox publish the person allows goes through altool with its own login', async ($, on) => {
  const w = world(on, { ask: 'Publish' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const called: any = await call($, 'publish', { appPath: 'Base', environmentId: `saas:${TENANT}/dev` })
  expect(JSON.parse(called.result.content[0].text).ok).toBe(true)
  const publish = w.spawned.find(s => s.argv[1] === 'publishapp')!
  expect(publish.argv).toContain('--environmentname')
  expect(publish.argv).toContain('dev')
  expect(publish.argv.join(' ')).not.toMatch(/tok/)
  expect(publish.input).toBeUndefined()
})

test('a broken app yields parsed errors and an Ask agent to fix button that hands over the diagnostics', async ($, on) => {
  const w = world(on, { compileOutput: `${APP}/src/Thing.al(12,5): error AL0118: The name 'Foo' does not exist`, compileCode: 1 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const called: any = await call($, 'compile', { appPath: 'Base' })
  const result = JSON.parse(called.result.content[0].text)
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]).toMatchObject({ code: 'AL0118', line: 12, column: 5 })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /✗ Compile failed: 1 error/ })).toBeTruthy()
  await band.press({ key: 'ask' })
  await band.unmount()
  expect(w.submitted[0]).toMatch(/Thing\.al\(12,5\): error AL0118/)
  expect(w.submitted[0]).toMatch(/publisher_compile/)
})

test('the guard steers shell publishes to the publisher tool and blocks production outright', async ($, on) => {
  world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: {} }))
  on('tool.call', { tool: 'PowerShell' }, () => ({ result: {} }))
  await start($)

  const steer: any = await $.tool.call({ tool: 'PowerShell', command: "Publish-BcContainerApp -containerName 'bc24-w1' -appFile x.app" })
  expect(steer.deny).toMatch(/publisher_publish/)

  const prod: any = await $.tool.call({ tool: 'Bash', command: `curl -X POST https://api.businesscentral.dynamics.com/v2.0/${TENANT}/Production/dev/apps -F file=@x.app` })
  expect(prod.deny).toMatch(/production/i)

  const fine: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(fine.deny).toBeUndefined()
})

test('/publish returns apps and environments as text where nothing is drawn', async ($, on) => {
  world(on, { isPlaced: false })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: WS, surface: 'terminal', isInteractive: false })

  const ran: any = await $.command.run({ command: 'publish', args: '' })
  expect(ran.text).toMatch(/Base 1\.0\.0\.0/)
  expect(ran.text).toMatch(/container:bc24-w1/)
  expect(ran.text).toMatch(/PRODUCTION: read-only/)
})

test('the band announces the mod, quietly, where there are AL apps', async ($, on) => {
  world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /BC Publisher · 1 app · 3 targets \(1 read-only\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'open' })).toBeTruthy()
  await ui.unmount()
})

test('the band stays out of the way where there are no AL apps', async ($, on) => {
  const w = world(on)
  delete w.files[`${APP}/app.json`]
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /BC Publisher/ })).toBeFalsy()
  await ui.unmount()
})

test('the guard also catches the publisher\'s own engine, al/altool publishapp', async ($, on) => {
  world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: {} }))
  on('tool.call', { tool: 'PowerShell' }, () => ({ result: {} }))
  await start($)

  const bare: any = await $.tool.call({ tool: 'Bash', command: 'al publishapp ./x.app --server http://bc24-w1 --serverinstance BC' })
  expect(bare.deny).toMatch(/publisher_publish/)
  const quoted: any = await $.tool.call({ tool: 'PowerShell', command: '& "C:/Users/me/.dotnet/tools/al.exe" publishapp x.app --environmenttype Sandbox --environmentname dev' })
  expect(quoted.deny).toMatch(/publisher_publish/)
  const prod: any = await $.tool.call({ tool: 'Bash', command: 'altool publishapp x.app --environmenttype Production --environmentname Production --tenant t' })
  expect(prod.deny).toMatch(/production/i)
  const unknown: any = await $.tool.call({ tool: 'Bash', command: 'al publishapp x.app --environmenttype Sandbox --environmentname not-in-the-list' })
  expect(unknown.deny).toMatch(/production|cannot be determined/i)
  const compile: any = await $.tool.call({ tool: 'Bash', command: 'al compile /project:.' })
  expect(compile.deny).toBeUndefined()
})

test('/publish accepts quoted app names and waits for the first discovery', async ($, on) => {
  const w = world(on)
  w.files[`${APP}/app.json`] = JSON.stringify({ id: 'b', name: 'Sales App', publisher: 'Acme', version: '1.0.0.0', dependencies: [] })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // no refresh first: the command has to wait for the discovery that session start began
  await $.session.start({ cwd: WS, surface: 'terminal', isInteractive: false })

  const ran: any = await $.command.run({ command: 'publish', args: 'compile "Sales App"' })
  expect(JSON.parse(ran.text).ok).toBe(true)
  const published: any = await $.command.run({ command: 'publish', args: 'publish "Sales App" container:bc24-w1' })
  expect(JSON.parse(published.text)[0].ok).toBe(true)
})

test('a target\'s own sync mode applies unless somebody chose one', async ($, on) => {
  const w = world(on, { forceSyncLaunch: true })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  await call($, 'publish', { appPath: 'Base', environmentId: 'container:bc24-w1' })
  const first = w.spawned.filter(s => s.argv[1] === 'publishapp').at(-1)!
  expect(first.argv[first.argv.indexOf('--schemaupdatemode') + 1]).toBe('ForceSync') // launch.json's, not a blanket "Add"

  await call($, 'publish', { appPath: 'Base', environmentId: 'container:bc24-w1', mode: 'Add' })
  const second = w.spawned.filter(s => s.argv[1] === 'publishapp').at(-1)!
  expect(second.argv[second.argv.indexOf('--schemaupdatemode') + 1]).toBe('Synchronize') // asked for explicitly
})

test('the apps the list tool shows are the ones compile accepts', async ($, on) => {
  const w = world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)
  // a second app appears after the session started
  w.files[`${WS}/late/app.json`] = JSON.stringify({ id: 'l', name: 'Late', publisher: 'Acme', version: '1.0.0.0', dependencies: [] })
  w.files[`${WS}/late/.alpackages/x.app`] = 'x'

  const before: any = await call($, 'compile', { appPath: 'Late' })
  expect(before.result.isError).toBe(true)
  await call($, 'list_apps', {})
  const after: any = await call($, 'compile', { appPath: 'Late' })
  expect(after.result.isError).toBe(false)
})
