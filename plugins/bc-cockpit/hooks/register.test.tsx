import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'bc-cockpit',
  component: 'Pane',
  requestId: 'cockpit',
  props: { title: 'Cockpit', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'bc-cockpit',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const BS = String.fromCharCode(92) // iteration paths are Project\Sprint
const CONFIG = JSON.stringify({ organisations: [{ name: 'orgA', projects: ['ProjA'] }], repoRoots: ['/repos'], refreshMinutes: 3, pipelineScope: 'all' })
const json = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })
const text = (value: string) => ({ value: { status: 200, ok: true, headers: {}, text: value } })
const FAILED_PIPELINE = 'b:orgA/ProjA/1/f' // the key of the red pipeline below
const REVIEW_PR = 'pr:orgA/5'

/**
 * What Azure DevOps answers for one org and one project: a red pipeline of mine with an AL error in its log, a PR
 * waiting on my review, and one task in my current sprint. `calm` makes it all quiet; `signedOut` fails sign-in.
 */
function azure(on: any, opts: { isPlaced?: boolean; withClone?: boolean; calm?: boolean; signedOut?: boolean } = {}) {
  const { isPlaced = true, withClone = false, calm = false, signedOut = false } = opts
  mock.clock(on)
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'cockpit' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_: any, e: any) => {
    // Windows hands paths over with backslashes
    const p = String(e.path).split(BS).join('/')
    if (p.endsWith('config.json')) return { value: CONFIG }
    if (withClone && p.endsWith('/.git/config')) return { value: '[remote "origin"]\n\turl = https://dev.azure.com/orgA/ProjA/_git/app' }
    throw new Error('ENOENT ' + p)
  })
  on('fs.list', (_: any, e: any) => {
    if (withClone && String(e.path).endsWith('repos')) return { value: [{ name: 'app', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    return { value: [] }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'tok\n', stderr: '' } }))
  on('http.fetch', (_: any, e: any) => {
    const url: string = e.url
    if (/connectionData/.test(url)) return signedOut ? { value: { status: 401, ok: false, headers: {}, text: '' } } : json({ authenticatedUser: { id: 'me' } })
    // the current sprint of the team I am on
    if (/\/projects\/ProjA\/teams/.test(url)) return json({ value: [{ id: 't1', name: 'ProjA Team' }] })
    if (/teamsettings\/iterations/.test(url)) return json({ value: [{ id: 'i1', name: 'Sprint 24', path: 'ProjA' + BS + 'Sprint 24', attributes: { finishDate: '2030-01-01T00:00:00Z' } }] })
    if (/wit\/wiql/.test(url)) return json({ workItems: [{ id: 1 }] })
    if (/workitemsbatch/.test(url)) {
      return json({ value: [{ id: 1, fields: { 'System.Title': 'Fix it', 'System.WorkItemType': 'Bug', 'System.State': 'Doing', 'System.TeamProject': 'ProjA', 'System.IterationPath': 'ProjA' + BS + 'Sprint 24', 'Microsoft.VSTS.Common.Priority': 1, 'System.ChangedDate': '2026-10-01T00:00:00Z' } }] })
    }
    if (/pullrequests/.test(url)) {
      return json({ value: [{ pullRequestId: 5, title: 'Review me', repository: { id: 'r', name: 'app' }, sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/main', mergeStatus: 'succeeded', createdBy: { id: 'other' }, reviewers: [{ id: 'me', vote: calm ? 10 : 0 }] }] })
    }
    // the failed build: its timeline, its log, and the build itself
    if (/builds\/9\/timeline/.test(url)) return json({ records: [{ type: 'Task', name: 'Compile AL app', result: 'failed', order: 1, log: { url: 'https://log/compile' } }] })
    if (/log\/compile/.test(url)) return text("2026-10-21T10:00:00Z Compiling\n2026-10-21T10:00:01Z src/A.al(5,9): error AL0118: The name 'Foo' does not exist\n2026-10-21T10:00:02Z ##[error]PowerShell exited with code '1'.")
    if (/builds\/9\?/.test(url)) return json({ id: 9, sourceBranch: 'refs/heads/f', sourceVersion: 'abcdef123456', definition: { name: 'CI' }, repository: { id: 'r', name: 'app' } })
    if (/build\/builds/.test(url)) {
      return json({ value: [{ id: 9, status: 'completed', result: calm ? 'succeeded' : 'failed', finishTime: '2026-10-21T10:00:00Z', sourceBranch: 'refs/heads/f', definition: { id: 1, name: 'CI' }, repository: { id: 'r', name: 'app' }, requestedFor: { id: 'me' } }] })
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
}

const start = async ($: any, isInteractive = true) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive })
  await $.command.run({ command: 'cockpit', args: 'refresh' })
}

test('the pane leads with what needs you, then the sprint, on every surface', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /NEEDS YOU/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `att-${FAILED_PIPELINE}` })).toBeTruthy() // the red pipeline
    expect(await ui.find({ type: 'Button', key: `att-${REVIEW_PR}` })).toBeTruthy() // the PR waiting on me
    expect(await ui.find({ type: 'Text', text: /Sprint 24/ })).toBeTruthy()
    expect(await ui.find({ type: 'Link', text: /Bug #1/ })).toBeTruthy() // my task, in this sprint
    await ui.unmount()
  }
})

test('a failure row shows its error without a click', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /error AL0118: The name 'Foo' does not exist/ })).toBeTruthy()
  await ui.unmount()
})

test('opening an item shows the trimmed log and where the clone is', async ($, on) => {
  azure(on, { withClone: true })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: `fix-${FAILED_PIPELINE}` })).toBeTruthy() // a clone exists: Fix is offered
  await ui.press({ key: `att-${FAILED_PIPELINE}` })
  expect(await ui.find({ type: 'Text', text: /Failed: Compile AL app/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `bg-${FAILED_PIPELINE}` })).toBeTruthy()
  await ui.unmount()
})

test('Fix is not offered without a local clone, and the row says so', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /no clone/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `fix-${FAILED_PIPELINE}` })).toBeFalsy()
  await ui.unmount()
})

test('the band names what needs you and offers a hotkey per item', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /✗ 1 failed · ◔ 1 to review/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `band-${FAILED_PIPELINE}` })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `band-${REVIEW_PR}` })).toBeTruthy()
  await ui.unmount()
})

test('the band is quiet when nothing needs you', async ($, on) => {
  azure(on, { calm: true })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /failed|to review|incomplete/ })).toBeFalsy()
  await ui.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /All clear/ })).toBeTruthy()
  await pane.unmount()
})

test('a board that could not be loaded is not "all clear": the band says incomplete', async ($, on) => {
  azure(on, { signedOut: true })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await start($)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /⚠ incomplete: 2 errors/ })).toBeTruthy()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /All clear/ })).toBeFalsy()
  await pane.unmount()
})

test('/cockpit returns the board as text where nothing is drawn, needs-you first', async ($, on) => {
  azure(on, { isPlaced: false })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const ran: any = await $.command.run({ command: 'cockpit', args: 'refresh' })
  expect(ran.text).toMatch(/^✗ 1 failed · ◔ 1 to review/)
  expect(ran.text.indexOf('## Needs you')).toBeLessThan(ran.text.indexOf('## Sprint 24'))
  expect(ran.text).toMatch(/1\. ✗ orgA\/ProjA · CI @ f/)
  expect(ran.text).toMatch(/Bug #1 P1 \[Doing\] Fix it/)
})

test('cockpit_get_board returns compact JSON to the agent', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const called: any = await $.tool.call({ tool: 'mcp__bc-cockpit__cockpit_refresh' })
  const board = JSON.parse(called.result.content[0].text)
  expect(board.needsYou.map((n: any) => n.kind)).toEqual(['pipeline', 'pr-review'])
  expect(board.sprints[0].name).toBe('Sprint 24')
  expect(board.workItems[0]).toMatchObject({ id: 1, sprint: 'Sprint 24', isClosed: false })
  expect(board.pipelines[0].state).toBe('failed')
})
