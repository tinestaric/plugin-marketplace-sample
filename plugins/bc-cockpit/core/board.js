import { normaliseBuild } from './azdo.js'
import { errorMessage, mapLimit } from './util.js'

const CONCURRENCY = 6

/** Latest build per definition and branch, newest first (input is queue-time descending). */
export function latestPerDefinition(builds) {
  const seen = new Set()
  return builds.filter(b => {
    const key = `${b.project}/${b.definitionId}/${b.branch}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Mine = requested by me, or on a source branch (or the PR-validation merge ref) of one of my open PRs. Every
 * pipeline is flagged, so "all" can show the lot while the attention list still nags only about mine.
 */
export function filterPipelines(builds, { scope, meId, prBranches }) {
  const latest = latestPerDefinition(builds).map(b => ({
    ...b,
    isMine: b.requestedForId === meId || prBranches.has(`${b.project}/${b.repoId}/${b.branch}`),
  }))
  return scope === 'all' ? latest : latest.filter(b => b.isMine)
}

const rank = { failed: 0, running: 1, queued: 2, canceled: 3, succeeded: 4 }
export const sortPipelines = list =>
  [...list].sort((a, b) => rank[a.state] - rank[b.state] || String(b.finished).localeCompare(String(a.finished)))

const stateOrder = item => (item.isClosed ? 2 : /^(doing|active|in progress|committed|approved)/i.test(item.state) ? 0 : 1)
/** Open work first (in progress, then not started), by priority; finished work last. */
export const sortWorkItems = list =>
  [...list].sort((a, b) => stateOrder(a) - stateOrder(b) || a.priority - b.priority || String(b.changed).localeCompare(String(a.changed)))

/** Fetches one organisation; every sub-call that fails lands in `errors` instead of throwing. */
export async function fetchOrganisation(client, org, scope, errors, { closedStates } = {}) {
  const note = (what, e) => errors.push({ org: org.name, scope: what, message: errorMessage(e) })

  let meId
  try {
    meId = await client.me(org.name)
  } catch (e) {
    note('sign-in', e)
    return { workItems: [], sprints: [], pullRequests: [], pipelines: [] }
  }

  let projects = []
  try {
    projects = org.projects === '*' || org.projects === undefined ? await client.projects(org.name) : org.projects
  } catch (e) {
    note('projects', e)
  }

  const perProject = await mapLimit(projects, CONCURRENCY, async project => {
    const [prs, builds, work] = await Promise.all([
      client.pullRequests(org.name, project, meId).catch(e => (note(`PRs in ${project}`, e), [])),
      client.builds(org.name, project).then(bs => bs.map(b => normaliseBuild(org.name, project, b))).catch(e => (note(`builds in ${project}`, e), [])),
      // only the current sprint counts: no sprint (or no team of mine) means nothing from this project
      client
        .sprints(org.name, project)
        .then(async sprints => ({ sprints, items: await client.sprintItems(org.name, project, sprints, { closedStates }) }))
        .catch(e => (note(`sprint in ${project}`, e), { sprints: [], items: [] })),
    ])
    await mapLimit(prs, CONCURRENCY, async pr => {
      pr.build = await client.prBuild(org.name, project, pr).catch(() => null)
    })
    return { prs, builds, work }
  })

  const pullRequests = perProject.flatMap(p => p.prs)
  // PR-validation builds run on refs/pull/<id>/merge, requested by a service account: they belong to my PR
  const prBranches = new Set(pullRequests.flatMap(pr => [`${pr.project}/${pr.repoId}/${pr.source}`, `${pr.project}/${pr.repoId}/refs/pull/${pr.id}/merge`]))
  const pipelines = perProject.flatMap(p => filterPipelines(p.builds, { scope, meId, prBranches }))
  const workItems = perProject.flatMap(p => p.work.items)
  // a sprint with nothing of mine in it is not worth a line
  const sprints = perProject.flatMap(p => p.work.sprints).filter(s => workItems.some(w => w.org === s.org && w.project === s.project && w.sprint === s.name))
  return { workItems, sprints, pullRequests, pipelines }
}

export async function buildBoard(client, config, now) {
  const errors = []
  const parts = await Promise.all(config.organisations.map(org => fetchOrganisation(client, org, config.pipelineScope, errors, { closedStates: config.closedStates })))
  return {
    workItems: sortWorkItems(parts.flatMap(p => p.workItems)),
    sprints: parts.flatMap(p => p.sprints),
    pullRequests: parts.flatMap(p => p.pullRequests),
    pipelines: sortPipelines(parts.flatMap(p => p.pipelines)),
    fetchedAt: now,
    errors,
    settings: { failureMaxAgeDays: config.failureMaxAgeDays },
  }
}

/** Keys of things whose status changed between two boards, for the "what changed" highlight. */
export function diffBoards(prev, next) {
  if (!prev) return []
  const changed = []
  const was = new Map(prev.pipelines.map(p => [`b:${p.org}/${p.project}/${p.definitionId}/${p.branch}`, p.state]))
  for (const p of next.pipelines) {
    const key = `b:${p.org}/${p.project}/${p.definitionId}/${p.branch}`
    if (was.has(key) && was.get(key) !== p.state) changed.push(key)
  }
  const prWas = new Map(prev.pullRequests.map(p => [`pr:${p.org}/${p.id}`, `${p.vote}|${p.mergeStatus}|${p.build}`]))
  for (const p of next.pullRequests) {
    const key = `pr:${p.org}/${p.id}`
    if (prWas.has(key) && prWas.get(key) !== `${p.vote}|${p.mergeStatus}|${p.build}`) changed.push(key)
  }
  return changed
}

export const pipelineKey = p => `b:${p.org}/${p.project}/${p.definitionId}/${p.branch}`
export const prKey = p => `pr:${p.org}/${p.id}`
