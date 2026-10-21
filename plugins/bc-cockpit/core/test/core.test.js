import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCockpit, boardToText, diffBoards, summarise } from '../index.js'
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
  const routes = [
    [/connectionData/, () => fx('connectionData.json')],
    [/_apis\/projects/, () => fx('projects.json')],
    [/wit\/wiql/, () => fx('wiql.json')],
    [/workitemsbatch/, () => fx('workitemsbatch.json')],
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
      const hit = routes.find(([re]) => re.test(url))
      if (!hit) return { status: 404, ok: false, text: '' }
      return { status: 200, ok: true, text: hit[1]() }
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
  // 2 projects in the fixture, each returns the same recorded data
  assert.equal(board.workItems.length, 2)
  assert.deepEqual(board.workItems.map(w => w.id), [12, 11], 'priority 1 before priority 2')
  assert.equal(board.workItems[0].url, 'https://dev.azure.com/orgA/ProjA/_workitems/edit/12')

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
  assert.match(summarise(board), /failed · 2 PRs waiting on you · 2 work items/)
  assert.match(boardToText(board), /## Pipelines/)
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
