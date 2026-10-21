import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { attentionItems, createCockpit, boardToText, diffBoards, summarise } from '../index.js'
import { filterPipelines } from '../board.js'
import { normaliseRemote, resolveLocalRepo } from '../repos.js'
import { trimStepLog, trimLogs, buildFixPrompt } from '../failure.js'
import { base64 } from '../util.js'

const fx = name => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const json = name => JSON.parse(fx(name))

/** An `io` whose network is the recorded fixtures. */
function fakeIo({ files = {}, dirs = {}, az = true, pat } = {}) {
  const calls = []
  const store = new Map()
  const BS = String.fromCharCode(92) // a backslash: iteration paths are Project\Sprint
  const segment = (url, i) => decodeURIComponent(url.split('/')[i] ?? '')
  const routes = [
    [/connectionData/, () => fx('connectionData.json')],
    // the sprint endpoints come before the project list, whose pattern would swallow them
    [/_apis\/projects\/[^/]+\/teams/, url => JSON.stringify({ value: [{ id: 'team1', name: decodeURIComponent(url.split('/projects/')[1].split('/')[0]) + ' Team' }] })],
    [/teamsettings\/iterations/, url => JSON.stringify({ value: [{ id: 'it1', name: 'Sprint 24', path: segment(url, 4) + BS + 'Sprint 24', attributes: { startDate: '2026-10-19T00:00:00Z', finishDate: '2026-10-30T00:00:00Z' } }] })],
    [/_apis\/projects/, () => fx('projects.json')],
    [/wit\/wiql/, url => (url.includes('/ProjA/') ? fx('wiql.json') : JSON.stringify({ workItems: [] }))],
    [/workitemsbatch/, (url, init) => JSON.stringify({ value: json('workitemsbatch.json').value.filter(w => JSON.parse(init.body).ids.includes(w.id)) })],
    [/searchCriteria\.creatorId/, () => fx('prs-mine.json')],
    [/searchCriteria\.reviewerId/, () => fx('prs-review.json')],
    [/refs%2Fpull%2F/, () => fx('prbuilds.json')],
    [/builds\/501\/timeline/, () => fx('timeline501.json')],
    [/builds\/501\?/, () => fx('build501.json')],
    [/_apis\/build\/builds\?/, () => fx('builds.json')],
    [/log\/compile/, () => fx('log-compile.txt')],
    [/log\/tests/, () => fx('log-tests.txt')],
  ]
  return {
    calls,
    home: '/home/me',
    now: () => 1_000_000,
    env: async name => (name === 'AZDO_PAT' ? pat : undefined),
    store: { get: async k => store.get(k), set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))) },
    async fetch(url, init = {}) {
      calls.push({ url, init })
      // the real service rejects fields it does not know (TF51005); the fixtures alone never noticed
      if (url.includes('wit/wiql') && (init.body ?? '').includes('StateCategory')) return { status: 400, ok: false, text: '{"message":"TF51005: The query references a field that does not exist."}' }
      const hit = routes.find(([re]) => re.test(url))
      if (!hit) return { status: 404, ok: false, text: '' }
      return { status: 200, ok: true, text: hit[1](url, init) }
    },
    async run(argv) {
      calls.push({ argv })
      return az ? { exitCode: 0, stdout: 'tok123\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'not logged in' }
    },
    fs: {
      async read(p) {
        if (p in files) return files[p]
        throw new Error('ENOENT ' + p)
      },
      async write(p, t) {
        files[p] = t
      },
      async exists(p) {
        return p in files
      },
      async list(p) {
        if (p in dirs) return dirs[p].map(name => ({ name, kind: 'dir' }))
        throw new Error('ENOENT ' + p)
      },
    },
  }
}

const NOW = Date.parse('2026-10-21T08:00:00Z') // the fixtures' week
const CONFIG = {
  organisations: [{ name: 'orgA', projects: '*' }],
  repoRoots: ['/repos'],
  refreshMinutes: 3,
  pipelineScope: 'mine',
}
const withConfig = (o = {}) => ({ files: { '/home/me/.bc-cockpit/config.json': JSON.stringify(CONFIG) }, ...o })

test('first run writes a commented example config', async () => {
  const io = fakeIo()
  const cockpit = createCockpit(io)
  const config = await cockpit.loadConfig()
  assert.equal(config.isExample, true)
  assert.match(io.fs && (await io.fs.read('/home/me/.bc-cockpit/config.json')), /organisations/)
})

test('getBoard merges work items, PRs and pipelines across projects', async () => {
  const io = fakeIo(withConfig())
  const board = await createCockpit(io).getBoard({ force: true })

  assert.deepEqual(board.errors, [])
  // my items in ProjA's current sprint: open work first (in progress, then not started), the finished item last
  assert.deepEqual(board.workItems.map(w => w.id), [11, 12, 13])
  assert.deepEqual(board.workItems.map(w => w.isClosed), [false, false, true])
  assert.equal(board.workItems[0].sprint, 'Sprint 24')
  assert.equal(board.workItems[0].url, 'https://dev.azure.com/orgA/ProjA/_workitems/edit/11')
  assert.deepEqual(board.sprints.map(x => [x.project, x.name]), [['ProjA', 'Sprint 24']], 'ProjB has a sprint but nothing of mine in it')

  const pr = board.pullRequests.find(p => p.id === 7 && p.project === 'ProjA')
  assert.equal(pr.isMine, true)
  assert.equal(pr.vote, 'waiting')
  assert.equal(pr.mergeStatus, 'conflicts')
  assert.equal(pr.build, 'failed')
  assert.equal(board.pullRequests.filter(p => p.project === 'ProjA').length, 2, 'mine + reviewer queries de-duplicated')
  const review = board.pullRequests.find(p => p.id === 9)
  assert.equal(review.isReviewer, true)
  assert.equal(review.myVote, 0)

  assert.equal(board.pipelines[0].state, 'failed', 'failures first')
  const text = boardToText(board, { now: NOW })
  assert.ok(text.indexOf('## Needs you') < text.indexOf('## Sprint 24'), 'what needs you comes first')
  assert.ok(text.indexOf('## Sprint 24') < text.indexOf('## Pipelines'))
})

test('pipelineScope: mine keeps my runs and my PR branches, all keeps every latest', () => {
  const mk = (id, def, branch, by, state = 'failed') => ({ project: 'P', definitionId: def, branch, repoId: 'r', requestedForId: by, state, buildId: id })
  const builds = [mk(3, 1, 'feature/x', 'bot'), mk(2, 1, 'feature/x', 'me'), mk(1, 2, 'main', 'bot')]
  const prBranches = new Set(['P/r/feature/x'])
  assert.deepEqual(filterPipelines(builds, { scope: 'mine', meId: 'me', prBranches }).map(b => b.buildId), [3])
  assert.deepEqual(filterPipelines(builds, { scope: 'all', meId: 'me', prBranches }).map(b => b.buildId), [3, 1])
})

test('one failing project does not break the board', async () => {
  const io = fakeIo(withConfig())
  const real = io.fetch
  io.fetch = async (url, init) => (/ProjB.*pullrequests/.test(url) ? { status: 500, ok: false, text: '' } : real(url, init))
  const board = await createCockpit(io).getBoard({ force: true })
  assert.equal(board.errors.length, 1)
  assert.match(board.errors[0].scope, /PRs in ProjB/)
  assert.ok(board.workItems.length > 0)
})

test('not signed in: no az, no PAT -> clear error with the command to run', async () => {
  const io = fakeIo(withConfig({ az: false }))
  const board = await createCockpit(io).getBoard({ force: true })
  assert.ok(board.errors.some(e => /az login/.test(e.message)))
})

test('PAT fallback sends Basic auth with an empty username', async () => {
  const io = fakeIo(withConfig({ az: false, pat: 'secret' }))
  await createCockpit(io).getBoard({ force: true })
  const auth = io.calls.find(c => c.init)?.init.headers.Authorization
  assert.equal(auth, 'Basic ' + base64(':secret'))
  assert.equal(base64(':secret'), Buffer.from(':secret').toString('base64'))
})

test('az token is requested for the Azure DevOps resource and cached', async () => {
  const io = fakeIo(withConfig())
  const cockpit = createCockpit(io)
  await cockpit.getBoard({ force: true })
  await cockpit.getBoard({ force: true })
  const az = io.calls.filter(c => c.argv)
  assert.equal(az.length, 1)
  assert.ok(az[0].argv.includes('499b84ac-1321-427f-aa17-267ca6975798'))
  assert.equal(io.calls.find(c => c.init).init.headers.Authorization, 'Bearer tok123')
})

test('cache: a second getBoard without force does not hit the network', async () => {
  const io = fakeIo(withConfig())
  const cockpit = createCockpit(io)
  await cockpit.getBoard({ force: true })
  const n = io.calls.length
  await cockpit.getBoard()
  assert.equal(io.calls.length, n)
})

test('normaliseRemote handles every Azure DevOps URL form', () => {
  const want = 'orga/proja/my app'
  for (const url of [
    'https://orgA@dev.azure.com/orgA/ProjA/_git/my%20app',
    'https://dev.azure.com/orgA/ProjA/_git/my%20app',
    'https://orga.visualstudio.com/ProjA/_git/my%20app',
    'https://orga.visualstudio.com/DefaultCollection/ProjA/_git/my%20app',
    'git@ssh.dev.azure.com:v3/orgA/ProjA/my app',
  ]) {
    assert.equal(normaliseRemote(url), want, url)
  }
  assert.equal(normaliseRemote('https://github.com/a/b.git'), null)
})

test('resolveLocalRepo finds the clone by remote, and says null when absent', async () => {
  const io = fakeIo({
    dirs: { '/repos': ['other', 'app'] },
    files: {
      '/repos/other/.git/config': '[remote "origin"]\n\turl = https://github.com/a/b.git',
      '/repos/app/.git/config': '[remote "origin"]\n\turl = https://orgA@dev.azure.com/orgA/ProjA/_git/app',
    },
  })
  assert.equal(await resolveLocalRepo(io, ['/missing', '/repos'], 'https://dev.azure.com/orgA/ProjA/_git/app'), '/repos/app')
  assert.equal(await resolveLocalRepo(io, ['/repos'], 'https://dev.azure.com/orgA/ProjA/_git/nope'), null)
})

test('trimStepLog keeps AL diagnostics and test failure blocks, else the last 40 lines', () => {
  const compile = trimStepLog(fx('log-compile.txt'))
  assert.match(compile, /error AL0118/)
  assert.match(compile, /warning AL0432/)
  assert.doesNotMatch(compile, /Compiling app/)

  const tests = trimStepLog(fx('log-tests.txt'))
  assert.match(tests, /Error Message: Expected 100 but got 90/)
  assert.match(tests, /PostInvoice line 12/)
  assert.match(tests, /Codeunit 50100/)
  assert.doesNotMatch(tests, /Finished/)

  const other = trimStepLog(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))
  assert.equal(other.split('\n').length, 40)
  assert.match(other, /line 99/)
})

test('trimLogs caps the result at about 8 KB', () => {
  const text = trimLogs([{ name: 'big', log: 'x'.repeat(20000) }])
  assert.ok(text.length <= 8000)
  assert.match(text, /truncated/)
})

test('getFailureDetails: failed steps in order, trimmed log, local clone, commit', async () => {
  const io = fakeIo(
    withConfig({
      dirs: { '/repos': ['app'] },
      files: {
        '/home/me/.bc-cockpit/config.json': JSON.stringify(CONFIG),
        '/repos/app/.git/config': '[remote "origin"]\n\turl = https://dev.azure.com/orgA/ProjA/_git/app',
      },
    }),
  )
  const f = await createCockpit(io).getFailureDetails({ org: 'orgA', project: 'ProjA', buildId: 501 })
  assert.deepEqual(f.failedSteps, ['Compile app', 'Run tests'])
  assert.equal(f.localPath, '/repos/app')
  assert.equal(f.branch, 'feature/x')
  assert.equal(f.commit, 'abcdef1234567890')
  assert.match(f.trimmedLog, /error AL0118/)
  assert.match(f.trimmedLog, /Expected 100 but got 90/)
  assert.ok(!io.calls.some(c => c.url?.includes('log/checkout')), 'only failed records are fetched')

  const prompt = buildFixPrompt(f)
  assert.match(prompt, /pipeline "CI" failed on branch feature\/x at commit abcdef1234/)
  assert.match(prompt, /local clone is at \/repos\/app/)
  assert.match(prompt, /Do not push/)
})

test('buildFixPrompt without a clone says so instead of inventing a path', () => {
  const p = buildFixPrompt({ pipeline: 'CI', branch: 'b', commit: 'abc', failedSteps: [], trimmedLog: '', localPath: null, org: 'o', project: 'p', repo: 'r', buildId: 1, buildUrl: 'u' })
  assert.match(p, /No local clone was found/)
})

test('diffBoards reports pipelines that changed state and PRs that changed vote', () => {
  const pipe = state => ({ org: 'o', project: 'p', definitionId: 1, branch: 'b', state })
  const pr = vote => ({ org: 'o', id: 1, vote, mergeStatus: 'succeeded', build: 'succeeded' })
  const a = { pipelines: [pipe('succeeded')], pullRequests: [pr('none')] }
  const b = { pipelines: [pipe('failed')], pullRequests: [pr('approved')] }
  assert.deepEqual(diffBoards(a, b), ['b:o/p/1/b', 'pr:o/1'])
  assert.deepEqual(diffBoards(null, b), [])
})

test('on Windows az is az.cmd: when it cannot be spawned directly, cmd.exe /c az is used', async () => {
  const io = fakeIo(withConfig())
  io.run = async argv => {
    if (argv[0] === 'cmd.exe') return { exitCode: 0, stdout: 'tok123\n', stderr: '' }
    throw new Error('spawn ' + argv[0] + ' ENOENT/EINVAL')
  }
  const board = await createCockpit(io).getBoard({ force: true })
  assert.deepEqual(board.errors, [])
})

test('a PR-validation build on refs/pull/<id>/merge counts as mine, whoever requested it', () => {
  const build = { project: 'P', definitionId: 1, repoId: 'r', branch: 'refs/pull/7/merge', requestedForId: 'service', state: 'failed', buildId: 1 }
  const prBranches = new Set(['P/r/feature/x', 'P/r/refs/pull/7/merge'])
  assert.equal(filterPipelines([build], { scope: 'mine', meId: 'me', prBranches }).length, 1)
  assert.equal(filterPipelines([build], { scope: 'mine', meId: 'me', prBranches: new Set(['P/r/feature/x']) }).length, 0)
})

test('a config.json with comments (as people and other tools write it) loads', async () => {
  const text = ['// BC Cockpit configuration', '{', '  // orgs', '  "organisations": [ { "name": "orgA", "projects": "*" } ], /* x */', '  "closedStates": ["Done"],', '}'].join('\n')
  const io = fakeIo({ files: { '/home/me/.bc-cockpit/config.json': text } })
  const c = await createCockpit(io).loadConfig()
  assert.equal(c.organisations[0].name, 'orgA')
  assert.deepEqual(c.closedStates, ['Done'])
})

// Lines as a real pipeline wrote them (self-hosted Windows agent, PowerShell task)
const REAL_BUILD_LOG = [
  '2026-10-21T12:14:23.2237599Z ##[section]Starting: Compile AL app',
  '2026-10-21T12:14:23.2283209Z Task         : PowerShell',
  '2026-10-21T12:14:28.9278963Z Compiling Cockpit Demo 1.0.0.0',
  "2026-10-21T12:14:28.9624743Z src/DemoHello.Codeunit.al(5,9): error AL0118: The name 'Foo' does not exist in the current context.",
  "2026-10-21T12:14:28.9793630Z ##[error]src/DemoHello.Codeunit.al(5,9): error : AL0118 The name 'Foo' does not exist in the current context.",
  "2026-10-21T12:14:29.2517961Z ##[error]PowerShell exited with code '1'.",
  '2026-10-21T12:14:29.3788741Z ##[section]Finishing: Compile AL app',
]
const REAL_TEST_LOG = [
  '2026-10-21T12:14:01.5955463Z Running tests',
  '2026-10-21T12:14:01.6516686Z Codeunit 50100 "Demo Tests"',
  '2026-10-21T12:14:01.6556139Z Method TestGreeting',
  "2026-10-21T12:14:01.6592156Z Error Message: Expected 'Hello from BC' but got 'Hi from broken'",
  '2026-10-21T12:14:01.6635154Z Call Stack:',
  '2026-10-21T12:14:01.6745511Z "Demo Tests"(CodeUnit 50100).TestGreeting line 5',
  "2026-10-21T12:14:01.9172625Z ##[error]PowerShell exited with code '1'.",
  '2026-10-21T12:14:02.0685231Z ##[section]Finishing: Run AL tests',
]

test('the log endpoint\'s JSON envelope is unwrapped to lines before trimming', async () => {
  const { logText } = await import('../failure.js')
  const envelope = JSON.stringify({ count: REAL_BUILD_LOG.length, value: REAL_BUILD_LOG })
  assert.equal(logText(envelope), REAL_BUILD_LOG.join('\n'))
  assert.equal(logText('plain text'), 'plain text', 'plain logs pass through')
  const trimmed = trimStepLog(logText(envelope))
  assert.equal(trimmed, "src/DemoHello.Codeunit.al(5,9): error AL0118: The name 'Foo' does not exist in the current context.")
})

test('a real test failure block is kept whole and stops at the pipeline markers', () => {
  const trimmed = trimStepLog(REAL_TEST_LOG.join('\n'))
  assert.equal(trimmed.split('\n').length, 5)
  assert.ok(trimmed.startsWith('Codeunit 50100 "Demo Tests"'))
  assert.ok(trimmed.includes("Expected 'Hello from BC' but got 'Hi from broken'"))
  assert.ok(trimmed.includes('TestGreeting line 5'))
  assert.ok(!trimmed.includes('##['))
})

test('build logs are requested as plain text', async () => {
  const io = fakeIo(withConfig({ dirs: { '/repos': [] } }))
  await createCockpit(io).getFailureDetails({ org: 'orgA', project: 'ProjA', buildId: 501 })
  const logCall = io.calls.find(c => c.url?.includes('log/compile'))
  assert.equal(logCall.init.headers.Accept, 'text/plain')
})

// ── current sprint ─────────────────────────────────────────────────────────

test('the work item query names the sprint paths and the project, with quotes escaped', async () => {
  const { sprintItemsQuery } = await import('../azdo.js')
  const BS = String.fromCharCode(92)
  const q = sprintItemsQuery("Cust'omer", ["Cust'omer" + BS + 'Sprint 3', "Cust'omer" + BS + 'Sprint 4'])
  assert.ok(!q.includes('StateCategory'), 'a field WIQL does not know')
  assert.ok(q.includes('[System.AssignedTo] = @Me'))
  assert.ok(q.includes("[System.TeamProject] = 'Cust''omer'"))
  assert.ok(q.includes("[System.IterationPath] UNDER 'Cust''omer" + BS + "Sprint 3' OR [System.IterationPath] UNDER 'Cust''omer" + BS + "Sprint 4'"))
})

test('only the current sprint of the teams I am on is queried', async () => {
  const io = fakeIo(withConfig())
  const board = await createCockpit(io).getBoard({ force: true })
  assert.deepEqual(board.errors, [])
  const urls = io.calls.map(c => c.url).filter(Boolean)
  assert.ok(urls.some(u => u.includes('/teams') && u.includes('$mine=true')), 'teams: mine only')
  assert.ok(urls.some(u => u.includes('teamsettings/iterations') && u.includes('$timeframe=current')), 'iterations: current only')
  const wiql = io.calls.find(c => c.url?.includes('/ProjA/') && c.url.includes('wit/wiql'))
  assert.ok(JSON.parse(wiql.init.body).query.includes('UNDER'), 'under the sprint, per project')
  assert.ok(!io.calls.some(c => c.url?.includes('dev.azure.com/orgA/_apis/wit/wiql')), 'no org-wide query any more')
})

test('a project with no sprint of mine contributes no work items, and no error (no fallback)', async () => {
  const io = fakeIo(withConfig())
  const real = io.fetch
  io.fetch = async (url, init) => (url.includes('/projects/ProjA/teams') ? { status: 200, ok: true, text: JSON.stringify({ value: [] }) } : real(url, init))
  const board = await createCockpit(io).getBoard({ force: true })
  assert.deepEqual(board.workItems, [])
  assert.deepEqual(board.sprints, [])
  assert.deepEqual(board.errors, [])
})

test('a team without work settings (404 on its iterations) is skipped quietly', async () => {
  const io = fakeIo(withConfig())
  const real = io.fetch
  io.fetch = async (url, init) => (url.includes('/ProjA/') && url.includes('teamsettings') ? { status: 404, ok: false, text: '' } : real(url, init))
  const board = await createCockpit(io).getBoard({ force: true })
  assert.deepEqual(board.errors, [], 'not an error')
  assert.deepEqual(board.workItems, [])
})

test('sprints are cached, so a refresh does not ask again', async () => {
  const io = fakeIo(withConfig())
  const cockpit = createCockpit(io)
  await cockpit.getBoard({ force: true })
  const asked = io.calls.filter(c => c.url?.includes('teamsettings')).length
  await cockpit.getBoard({ force: true })
  assert.equal(io.calls.filter(c => c.url?.includes('teamsettings')).length, asked)
})

test('sprintEnds says when a sprint ends', async () => {
  const { sprintEnds } = await import('../index.js')
  const now = Date.parse('2026-10-27T12:00:00Z')
  assert.equal(sprintEnds({ finish: '2026-10-30T00:00:00Z' }, now), 'ends in 3d')
  assert.equal(sprintEnds({ finish: '2026-10-28T00:00:00Z' }, now), 'ends tomorrow')
  assert.equal(sprintEnds({ finish: '2026-10-27T20:00:00Z' }, now), 'ends today')
  assert.equal(sprintEnds({ finish: '2026-10-24T00:00:00Z' }, now), 'ended 3d ago')
  assert.equal(sprintEnds({ finish: null }, now), '', 'a sprint without dates says nothing')
})

// ── what needs you ─────────────────────────────────────────────────────────

const DAY = 86_400_000
const pipe = (o = {}) => ({ org: 'o', project: 'p', definitionId: 1, definition: 'CI', branch: 'main', state: 'failed', isMine: true, finished: new Date(NOW - DAY).toISOString(), url: 'u', ...o })
const pr = (o = {}) => ({ org: 'o', project: 'p', id: 1, title: 't', source: 'f', isDraft: false, isMine: true, isReviewer: false, myVote: null, vote: 'none', mergeStatus: 'succeeded', build: null, created: new Date(NOW - DAY).toISOString(), url: 'u', ...o })
const boardOf = (pipelines = [], pullRequests = [], errors = []) => ({ pipelines, pullRequests, workItems: [], sprints: [], errors, fetchedAt: NOW })
const kinds = (board, opts) => attentionItems(board, { now: NOW, ...opts }).map(i => i.kind)

test("a failed pipeline of mine needs me; passing, running and other people's do not", () => {
  assert.deepEqual(kinds(boardOf([pipe()])), ['pipeline'])
  assert.deepEqual(kinds(boardOf([pipe({ state: 'succeeded' }), pipe({ state: 'running' }), pipe({ isMine: false })])), [])
})

test('a failure older than the cutoff is history; the cutoff is configurable (default 7 days)', () => {
  const old = pipe({ finished: new Date(NOW - 8 * DAY).toISOString() })
  assert.deepEqual(kinds(boardOf([old])), [])
  assert.deepEqual(kinds(boardOf([pipe({ finished: new Date(NOW - 6 * DAY).toISOString() })])), ['pipeline'])
  assert.deepEqual(kinds(boardOf([old]), { maxAgeDays: 30 }), ['pipeline'])
  assert.deepEqual(kinds({ ...boardOf([old]), settings: { failureMaxAgeDays: 14 } }), ['pipeline'], 'from the config, carried on the board')
})

test('a failure on a branch with no open PR still counts: that is when you want to know', () => {
  assert.deepEqual(kinds(boardOf([pipe({ branch: 'feature/not-yet-a-pr' })], [])), ['pipeline'])
})

test('my PR in trouble: conflicts, failed build, changes requested, rejected; drafts never nag', () => {
  assert.deepEqual(kinds(boardOf([], [pr({ mergeStatus: 'conflicts' })])), ['pr-problem'])
  assert.deepEqual(kinds(boardOf([], [pr({ build: 'failed' })])), ['pr-problem'])
  assert.deepEqual(kinds(boardOf([], [pr({ vote: 'waiting' })])), ['pr-problem'])
  assert.deepEqual(kinds(boardOf([], [pr({ vote: 'rejected' })])), ['pr-problem'])
  assert.deepEqual(kinds(boardOf([], [pr({ mergeStatus: 'conflicts', isDraft: true })])), [])
  assert.equal(attentionItems(boardOf([], [pr({ mergeStatus: 'conflicts', build: 'failed' })]), { now: NOW })[0].reason, 'merge conflicts, build failed')
})

test('a PR waiting on my review, and my approved PR ready to complete', () => {
  assert.deepEqual(kinds(boardOf([], [pr({ isMine: false, isReviewer: true, myVote: 0 })])), ['pr-review'])
  assert.deepEqual(kinds(boardOf([], [pr({ isMine: false, isReviewer: true, myVote: 10 })])), [], 'already voted')
  assert.deepEqual(kinds(boardOf([], [pr({ isMine: false, isReviewer: true, myVote: 0, isDraft: true })])), [], 'a draft is not ready for review')
  assert.deepEqual(kinds(boardOf([], [pr({ vote: 'approved' })])), ['pr-ready'])
  assert.deepEqual(kinds(boardOf([], [pr({ vote: 'approved', build: 'failed' })])), ['pr-problem'], 'approved but red is trouble, not good news')
  assert.deepEqual(kinds(boardOf([], [pr()])), [], 'a healthy PR in flight is not news')
})

test('the list is ordered: red builds, PRs in trouble, reviews, ready to complete', () => {
  const board = boardOf([pipe()], [pr({ id: 4, vote: 'approved' }), pr({ id: 3, isMine: false, isReviewer: true, myVote: 0 }), pr({ id: 2, mergeStatus: 'conflicts' })])
  assert.deepEqual(kinds(board), ['pipeline', 'pr-problem', 'pr-review', 'pr-ready'])
})

test('the summary names what needs you, says all clear when nothing does, and never calls an incomplete board clear', () => {
  const full = boardOf([pipe(), pipe({ definitionId: 2 })], [pr({ mergeStatus: 'conflicts' }), pr({ id: 3, isMine: false, isReviewer: true, myVote: 0 }), pr({ id: 4, vote: 'approved' })])
  assert.equal(summarise(full, { now: NOW }), '✗ 2 failed · ⚠ 1 PR in trouble · ◔ 1 to review · ✓ 1 ready to complete')
  assert.equal(summarise(boardOf(), { now: NOW }), '✓ all clear')
  const incomplete = boardOf([], [], [{ org: 'a', scope: 'sign-in', message: 'x' }])
  assert.equal(summarise(incomplete, { now: NOW }), '⚠ incomplete: 1 error')
  assert.ok(summarise(boardOf([pipe()], [], incomplete.errors), { now: NOW }).startsWith('✗ 1 failed'))
  assert.equal(summarise(null), 'loading…')
})

test('a PR whose red build is already a pipeline row is not listed a second time for that build', () => {
  const failedPrBuild = pipe({ definition: 'PR validation', branch: 'refs/pull/2/merge', definitionId: 9 })
  const board = boardOf([failedPrBuild], [pr({ id: 2, source: 'feature/x', build: 'failed' }), pr({ id: 3, build: 'failed', mergeStatus: 'conflicts' })])
  const items = attentionItems(board, { now: NOW })
  assert.deepEqual(items.map(i => i.kind), ['pipeline', 'pr-problem'])
  assert.equal(items[0].branch, 'PR !2 (feature/x)', 'named after the PR, not the merge ref')
  assert.equal(items[1].title, '!3 t', 'PR 3 has no pipeline row, so its failed build still counts')
  assert.equal(items[1].reason, 'merge conflicts, build failed')
  // PR 2 has nothing else wrong, so it adds no row of its own
  assert.ok(!items.some(i => i.pr?.id === 2))
  // ...but its conflicts would still show
  const conflicted = attentionItems(boardOf([failedPrBuild], [pr({ id: 2, source: 'feature/x', build: 'failed', mergeStatus: 'conflicts' })]), { now: NOW })
  assert.deepEqual(conflicted.map(i => i.reason), ['failed', 'merge conflicts'])
})

test('firstError picks the compiler error or test message, not a step header', async () => {
  const { firstError } = await import('../failure.js')
  assert.equal(firstError("### Compile AL app\nsrc/A.al(5,9): error AL0118: The name 'Foo' does not exist"), "src/A.al(5,9): error AL0118: The name 'Foo' does not exist")
  assert.equal(firstError('### Run AL tests\nCodeunit 50100 "Demo Tests"\nMethod TestGreeting\nError Message: Expected 1 but got 2\nCall Stack:'), 'Expected 1 but got 2')
  assert.equal(firstError('### Build\nsomething went wrong\nmore'), 'something went wrong')
  assert.equal(firstError(''), '')
})
