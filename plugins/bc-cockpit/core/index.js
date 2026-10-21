// BC Cockpit core: host-neutral, no npm dependencies, no mods API.
// All I/O arrives through `io`:
//   io.fetch(url, init) -> { status, ok, text }      io.run(argv, init) -> { exitCode, stdout, stderr }
//   io.fs { read, write, list, exists }              io.store { get, set }
//   io.env(name) -> string | undefined               io.home, io.now()
import { createAuth, SIGN_IN_HINT } from './auth.js'
import { createClient } from './azdo.js'
import { buildBoard, diffBoards } from './board.js'
import { loadConfig as loadConfigFrom } from './config.js'
import { buildFixPrompt, getFailureDetails as getFailure } from './failure.js'
import { resolveLocalRepo as resolveRepo } from './repos.js'
import { errorMessage } from './util.js'

export { buildFixPrompt, diffBoards, SIGN_IN_HINT }
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
    pullRequests: [],
    pipelines: [],
    fetchedAt: now,
    errors: message ? [{ org: '*', scope: 'setup', message }] : [],
    changed: [],
  }
}

/** One-line summary used by the band and the text fallback. */
export function summarise(board) {
  if (!board) return 'loading…'
  const failed = board.pipelines.filter(p => p.state === 'failed').length
  const waiting = board.pullRequests.filter(p => p.isReviewer && !p.isMine && p.myVote === 0).length
  return `${failed ? `● ${failed} failed` : '● all green'} · ${waiting} PRs waiting on you · ${board.workItems.length} work items`
}

/** Plain-text board for `claude -p` and the agent tool. */
export function boardToText(board) {
  const lines = [summarise(board), '']
  const group = (title, rows) => rows.length && lines.push(`## ${title}`, ...rows, '')
  group('Pipelines', board.pipelines.map(p => `- [${p.state}] ${p.org}/${p.project} · ${p.definition} @ ${p.branch} (build ${p.buildId}) ${p.url}`))
  group(
    'Pull requests',
    board.pullRequests.map(
      p => `- ${p.isReviewer && !p.isMine && p.myVote === 0 ? '[review requested] ' : ''}${p.org}/${p.project} · !${p.id} ${p.title} (${p.source} → ${p.target}) vote=${p.vote} merge=${p.mergeStatus} build=${p.build ?? '-'}${p.isDraft ? ' draft' : ''} ${p.url}`,
    ),
  )
  group('Work items', board.workItems.map(w => `- ${w.project} · ${w.type} #${w.id} P${w.priority} [${w.state}] ${w.title} ${w.url}`))
  if (board.errors.length) group('Errors', board.errors.map(e => `- ${e.org} ${e.scope}: ${e.message}`))
  return lines.join('\n').trimEnd()
}

/** Compact JSON for the cockpit_get_board tool. */
export function boardToCompact(board) {
  return {
    fetchedAt: board.fetchedAt,
    summary: summarise(board),
    pipelines: board.pipelines.map(({ org, project, definition, branch, state, buildId, finished, url }) => ({ org, project, definition, branch, state, buildId, finished, url })),
    pullRequests: board.pullRequests.map(({ org, project, id, title, repo, source, target, isDraft, isMine, myVote, vote, mergeStatus, build, url }) => ({ org, project, id, title, repo, source, target, isDraft, isMine, myVote, vote, mergeStatus, build, url })),
    workItems: board.workItems.map(({ org, project, id, type, title, state, priority, url }) => ({ org, project, id, type, title, state, priority, url })),
    errors: board.errors,
  }
}
