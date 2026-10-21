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

const CONFIG = JSON.stringify({ organisations: [{ name: 'orgA', projects: ['ProjA'] }], repoRoots: ['/repos'], refreshMinutes: 3, pipelineScope: 'all' })
const json = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })

// What Azure DevOps answers for one org, one project: a red pipeline and a PR waiting on me.
function azure(on: any, isPlaced = true) {
  mock.clock(on)
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'cockpit' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_: any, e: any) => ({ value: String(e.path).endsWith('config.json') ? CONFIG : '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'tok\n', stderr: '' } }))
  on('http.fetch', (_: any, e: any) => {
    const url: string = e.url
    if (/connectionData/.test(url)) return json({ authenticatedUser: { id: 'me' } })
    if (/wit\/wiql/.test(url)) return json({ workItems: [{ id: 1 }] })
    if (/workitemsbatch/.test(url)) {
      return json({ value: [{ id: 1, fields: { 'System.Title': 'Fix it', 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.TeamProject': 'ProjA', 'Microsoft.VSTS.Common.Priority': 1, 'System.ChangedDate': '2026-10-01T00:00:00Z' } }] })
    }
    if (/pullrequests/.test(url)) {
      return json({ value: [{ pullRequestId: 5, title: 'Review me', repository: { id: 'r', name: 'app' }, sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/main', mergeStatus: 'succeeded', createdBy: { id: 'other' }, reviewers: [{ id: 'me', vote: 0 }] }] })
    }
    if (/build\/builds/.test(url)) {
      return json({ value: [{ id: 9, status: 'completed', result: 'failed', sourceBranch: 'refs/heads/f', definition: { id: 1, name: 'CI' }, repository: { id: 'r', name: 'app' }, requestedFor: { id: 'me' } }] })
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
}

test('the pane shows the three sections, on every surface', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'cockpit', args: 'refresh' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /My work/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /My PRs/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Pipelines/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /CI @ f/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the band summarises the board and offers a hotkey per failed pipeline', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'cockpit', args: 'refresh' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /1 failed · 1 PRs waiting on you · 1 work items/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'fail-9' })).toBeTruthy()
  await ui.unmount()
})

test('Fix with agent is not offered without a local clone', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'cockpit', args: 'refresh' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fix with agent unavailable/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'fix-9' })).toBeFalsy()
  await ui.unmount()
})

test('/cockpit returns the board as text where nothing is drawn', async ($, on) => {
  azure(on, false)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const ran: any = await $.command.run({ command: 'cockpit', args: 'refresh' })
  expect(ran.text).toMatch(/## Pipelines/)
  expect(ran.text).toMatch(/\[failed\] orgA\/ProjA · CI @ f/)
})

test('cockpit_get_board returns compact JSON to the agent', async ($, on) => {
  azure(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const called: any = await $.tool.call({ tool: 'mcp__bc-cockpit__cockpit_refresh' })
  const board = JSON.parse(called.result.content[0].text)
  expect(board.pipelines[0].state).toBe('failed')
  expect(board.workItems[0].id).toBe(1)
})
