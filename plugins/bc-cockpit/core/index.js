// BC Cockpit core: host-neutral, no npm dependencies, no mods API.
// All I/O arrives through `io`:
//   io.fetch(url, init) -> { status, ok, text }      io.run(argv, init) -> { exitCode, stdout, stderr }
//   io.fs { read, write, list, exists }              io.store { get, set }
//   io.env(name) -> string | undefined               io.home, io.now()
import { createAuth, SIGN_IN_HINT } from './auth.js'
import { createClient } from './azdo.js'
import { attentionItems, GLYPH } from './attention.js'
import { buildBoard, diffBoards } from './board.js'
import { loadConfig as loadConfigFrom } from './config.js'
import { buildFixPrompt, firstError, getFailureDetails as getFailure } from './failure.js'
import { resolveLocalRepo as resolveRepo } from './repos.js'
import { errorMessage } from './util.js'

export { attentionItems, buildFixPrompt, diffBoards, firstError, GLYPH, SIGN_IN_HINT }
export { pipelineKey, prKey } from './board.js'

const CACHE_KEY = 'board'

export function createCockpit(io) {
  const auth = createAuth(io)
  const client = createClient(io, auth)
  let board = null
  let inflight = null

  const loadConfig = () => loadConfigFrom(io)

  async function readCache() {
    if (board) return board
    try {
      const cached = await io.store.get(CACHE_KEY)
      if (cached && typeof cached === 'object') board = cached
    } catch {
      /* a cold start is fine */
    }
    return board
  }

  /** Returns the cached board unless `force`; concurrent refreshes share one fetch. */
  async function getBoard({ force = false } = {}) {
    if (!force && (await readCache())) return board
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const config = await loadConfig()
        if (config.organisations.length === 0 || config.isExample) {
          return (board = emptyBoard(io.now(), `Edit ${config.path} and list your organisations.`))
        }
        const next = await buildBoard(client, config, io.now())
        const signedOut = next.errors.some(e => e.scope === 'sign-in' && /sign in|Not signed in/i.test(e.message))
        if (signedOut && !next.workItems.length) next.errors.unshift({ org: '*', scope: 'auth', message: SIGN_IN_HINT })
        await attachLocalClones(next, config.repoRoots)
        next.changed = diffBoards(board, next)
        board = next
        await io.store.set(CACHE_KEY, board).catch(() => {})
        return board
      } catch (e) {
        const base = board ?? emptyBoard(io.now())
        return (board = { ...base, errors: [...base.errors, { org: '*', scope: 'refresh', message: errorMessage(e) }] })
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** Marks each failed pipeline with the local clone of its repo (or null), so the UI can gate "Fix with agent". */
  async function attachLocalClones(next, repoRoots) {
    const seen = new Map()
    for (const p of next.pipelines) {
      if (p.state !== 'failed') continue
      const e = encodeURIComponent
      const remote = `https://dev.azure.com/${e(p.org)}/${e(p.project)}/_git/${e(p.repo ?? '')}`
      if (!seen.has(remote)) seen.set(remote, await resolveRepo(io, repoRoots, remote).catch(() => null))
      p.localPath = seen.get(remote)
    }
  }

  async function getFailureDetails(buildRef) {
    const config = await loadConfig()
    return getFailure(io, client, config.repoRoots, buildRef)
  }

  async function resolveLocalRepo(remoteUrl) {
    const config = await loadConfig()
    return resolveRepo(io, config.repoRoots, remoteUrl)
  }

  return { loadConfig, getBoard, getFailureDetails, buildFixPrompt, resolveLocalRepo }
}

export function emptyBoard(now, message) {
  return {
    workItems: [],
    sprints: [],
    pullRequests: [],
    pipelines: [],
    fetchedAt: now,
    errors: message ? [{ org: '*', scope: 'setup', message }] : [],
    changed: [],
  }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The one-line status: what needs the person, or "all clear". Missing results are never good news, so a load
 * failure is said out loud and the board is never called clear while it is incomplete.
 */
export function summarise(board, opts) {
  if (!board) return 'loading…'
  const items = attentionItems(board, opts)
  const count = kind => items.filter(i => i.kind === kind).length
  const parts = []
  if (count('pipeline')) parts.push(`✗ ${count('pipeline')} failed`)
  if (count('pr-problem')) parts.push(`⚠ ${plural(count('pr-problem'), 'PR')} in trouble`)
  if (count('pr-review')) parts.push(`◔ ${count('pr-review')} to review`)
  if (count('pr-ready')) parts.push(`✓ ${count('pr-ready')} ready to complete`)
  const problems = board.errors?.length ?? 0
  if (problems) parts.push(`⚠ incomplete: ${plural(problems, 'error')}`)
  return parts.length ? parts.join(' · ') : '✓ all clear'
}

/** "ends in 3d" / "ends today" / "ended 2d ago" for a sprint; empty when it has no end date. */
export function sprintEnds(sprint, now = Date.now()) {
  const end = Date.parse(sprint.finish ?? '')
  if (!end) return ''
  // a sprint ends on a date, not at an hour: compare calendar days
  const day = t => Math.floor(t / 86_400_000)
  const days = day(end) - day(now)
  return days > 1 ? `ends in ${days}d` : days === 1 ? 'ends tomorrow' : days === 0 ? 'ends today' : `ended ${-days}d ago`
}

/** Plain-text board for `claude -p` and the agent tool: what needs you first, then your sprint, then the rest. */
export function boardToText(board, opts) {
  const lines = [summarise(board, opts), '']
  const group = (title, rows) => rows.length && lines.push(`## ${title}`, ...rows, '')
  const items = attentionItems(board, opts)
  group('Needs you', items.map((i, n) => `${n + 1}. ${GLYPH[i.kind]} ${i.where} · ${i.title}${i.branch ? ` @ ${i.branch}` : ''} — ${i.reason} ${i.url}`))
  for (const s of board.sprints ?? []) {
    const mine = board.workItems.filter(w => w.org === s.org && w.project === s.project && w.sprint === s.name)
    const open = mine.filter(w => !w.isClosed)
    group(
      `${s.name} · ${s.org}/${s.project}${sprintEnds(s) ? ` (${sprintEnds(s)})` : ''}`,
      [...open.map(w => `- ${w.type} #${w.id} P${w.priority} [${w.state}] ${w.title} ${w.url}`), ...(mine.length > open.length ? [`- (${mine.length - open.length} done)`] : [])],
    )
  }
  group(
    'Pull requests',
    board.pullRequests.map(p => `- ${p.org}/${p.project} · !${p.id} ${p.title} (${p.source} → ${p.target}) vote=${p.vote} merge=${p.mergeStatus} build=${p.build ?? '-'}${p.isDraft ? ' draft' : ''}${p.isMine ? '' : ' (reviewing)'} ${p.url}`),
  )
  group('Pipelines', board.pipelines.map(p => `- [${p.state}] ${p.org}/${p.project} · ${p.definition} @ ${p.branch} (build ${p.buildId}) ${p.url}`))
  if (board.errors.length) group('Errors', board.errors.map(e => `- ${e.org} ${e.scope}: ${e.message}`))
  return lines.join('\n').trimEnd()
}

/** Compact JSON for the cockpit_get_board tool. */
export function boardToCompact(board, opts) {
  return {
    fetchedAt: board.fetchedAt,
    summary: summarise(board, opts),
    needsYou: attentionItems(board, opts).map(({ kind, org, title, where, branch, reason, url }) => ({ kind, where, title, branch, reason, url })),
    sprints: (board.sprints ?? []).map(({ org, project, name, finish }) => ({ org, project, name, finish })),
    workItems: board.workItems.map(({ org, project, id, type, title, state, isClosed, sprint, priority, url }) => ({ org, project, id, type, title, state, isClosed, sprint, priority, url })),
    pullRequests: board.pullRequests.map(({ org, project, id, title, repo, source, target, isDraft, isMine, myVote, vote, mergeStatus, build, url }) => ({ org, project, id, title, repo, source, target, isDraft, isMine, myVote, vote, mergeStatus, build, url })),
    pipelines: board.pipelines.map(({ org, project, definition, branch, state, isMine, buildId, finished, url }) => ({ org, project, definition, branch, state, isMine, buildId, finished, url })),
    errors: board.errors,
  }
}
