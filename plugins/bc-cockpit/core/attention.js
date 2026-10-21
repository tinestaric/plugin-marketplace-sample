import { pipelineKey, prKey } from './board.js'

const DAY = 24 * 60 * 60 * 1000
export const DEFAULT_FAILURE_MAX_AGE_DAYS = 7

// Order of the list: a red build of mine, then my PR in trouble, then someone waiting on me, then good news to act on.
const RANK = { pipeline: 0, 'pr-problem': 1, 'pr-review': 2, 'pr-ready': 3 }

/** Why one of my PRs is in trouble (empty: it is not). Drafts are work in progress and never nag. */
export function prProblems(pr) {
  if (pr.isDraft || !pr.isMine) return []
  const out = []
  if (pr.mergeStatus === 'conflicts') out.push('merge conflicts')
  if (pr.build === 'failed') out.push('build failed')
  if (pr.vote === 'rejected') out.push('rejected')
  else if (pr.vote === 'waiting') out.push('changes requested')
  return out
}

/**
 * Everything that needs the person, in the order to deal with it. One list for the band, the pane and the text
 * output, so "1" means the same thing everywhere.
 *   - a failed pipeline of mine, if it finished within `maxAgeDays` (older reds are history, not news)
 *   - my PR with conflicts, a failed build, or changes requested
 *   - a PR waiting on my review
 *   - my PR approved with nothing in the way: ready to complete
 */
export function attentionItems(board, { now = Date.now(), maxAgeDays } = {}) {
  if (!board) return []
  maxAgeDays ??= board.settings?.failureMaxAgeDays ?? DEFAULT_FAILURE_MAX_AGE_DAYS
  const items = []
  const prAt = new Map(board.pullRequests.map(pr => [`${pr.org}/${pr.project}/${pr.id}`, pr]))
  const redThroughPipeline = new Set() // PRs whose failed build is already a row of its own: said once, not twice

  for (const p of board.pipelines) {
    if (p.state !== 'failed' || p.isMine === false) continue
    const finished = Date.parse(p.finished ?? '')
    if (finished && now - finished > maxAgeDays * DAY) continue
    // a PR-validation build runs on refs/pull/<id>/merge: name the PR instead of the ref
    const m = /^refs\/pull\/(\d+)\/merge$/.exec(p.branch ?? '')
    const owner = m ? prAt.get(`${p.org}/${p.project}/${m[1]}`) : undefined
    if (owner) redThroughPipeline.add(prKey(owner))
    items.push({ key: pipelineKey(p), kind: 'pipeline', title: p.definition, where: `${p.org}/${p.project}`, branch: owner ? `PR !${owner.id} (${owner.source})` : p.branch, reason: 'failed', at: p.finished, url: p.url, pipeline: p })
  }

  for (const pr of board.pullRequests) {
    const where = `${pr.org}/${pr.project}`
    const base = { key: prKey(pr), title: `!${pr.id} ${pr.title}`, where, branch: pr.source, at: pr.created, url: pr.url, pr }
    const problems = prProblems(pr).filter(reason => !(reason === 'build failed' && redThroughPipeline.has(prKey(pr))))
    if (problems.length) items.push({ ...base, kind: 'pr-problem', reason: problems.join(', ') })
    else if (!pr.isDraft && !pr.isMine && pr.isReviewer && (pr.myVote === 0 || pr.myVote === null)) items.push({ ...base, kind: 'pr-review', reason: 'waiting on your review' })
    else if (!pr.isDraft && pr.isMine && pr.vote === 'approved' && pr.mergeStatus !== 'conflicts' && pr.build !== 'failed') items.push({ ...base, kind: 'pr-ready', reason: 'approved: ready to complete' })
  }

  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || String(b.at ?? '').localeCompare(String(a.at ?? '')))
}

export const GLYPH = { pipeline: '✗', 'pr-problem': '⚠', 'pr-review': '◔', 'pr-ready': '✓' }
