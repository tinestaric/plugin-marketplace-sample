import { normaliseBuild } from './azdo.js'
import { errorMessage, mapLimit } from './util.js'

const CONCURRENCY = 6

/** Latest build per definition, newest first (input is queue-time descending). */
export function latestPerDefinition(builds) {
  const seen = new Set()
  return builds.filter(b => {
    const key = `${b.project}/${b.definitionId}/${b.branch}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** pipelineScope 'mine': requested by me, or on a source branch of one of my open PRs. */
export function filterPipelines(builds, { scope, meId, prBranches }) {
  const latest = latestPerDefinition(builds)
  if (scope === 'all') return latest
  return latest.filter(b => b.requestedForId === meId || prBranches.has(`${b.project}/${b.repoId}/${b.branch}`))
}

const rank = { failed: 0, running: 1, queued: 2, canceled: 3, succeeded: 4 }
export const sortPipelines = list =>
  [...list].sort((a, b) => rank[a.state] - rank[b.state] || String(b.finished).localeCompare(String(a.finished)))

export const sortWorkItems = list =>
  [...list].sort((a, b) => a.project.localeCompare(b.project) || a.priority - b.priority || String(b.changed).localeCompare(String(a.changed)))

/** Fetches one organisation; every sub-call that fails lands in `errors` instead of throwing. */
export async function fetchOrganisation(client, org, scope, errors) {
  const note = (what, e) => errors.push({ org: org.name, scope: what, message: errorMessage(e) })

  let meId
  try {
    meId = await client.me(org.name)
  } catch (e) {
    note('sign-in', e)
    return { workItems: [], pullRequests: [], pipelines: [] }
  }

  let projects = []
  try {
    projects = org.projects === '*' || org.projects === undefined ? await client.projects(org.name) : org.projects
  } catch (e) {
    note('projects', e)
  }

  const [workItems, perProject] = await Promise.all([
    client.workItems(org.name).catch(e => (note('work items', e), [])),
    mapLimit(projects, CONCURRENCY, async project => {
      const [prs, builds] = await Promise.all([
        client.pullRequests(org.name, project, meId).catch(e => (note(`PRs in ${project}`, e), [])),
        client.builds(org.name, project).then(bs => bs.map(b => normaliseBuild(org.name, project, b))).catch(e => (note(`builds in ${project}`, e), [])),
      ])
      await mapLimit(prs, CONCURRENCY, async pr => {
        pr.build = await client.prBuild(org.name, project, pr).catch(() => null)
      })
      return { prs, builds }
    }),
  ])

  const pullRequests = perProject.flatMap(p => p.prs)
  const prBranches = new Set(pullRequests.map(pr => `${pr.project}/${pr.repoId}/${pr.source}`))
  const pipelines = perProject.flatMap(p => filterPipelines(p.builds, { scope, meId, prBranches }))
  return { workItems, pullRequests, pipelines }
}

export async function buildBoard(client, config, now) {
  const errors = []
  const parts = await Promise.all(config.organisations.map(org => fetchOrganisation(client, org, config.pipelineScope, errors)))
  return {
    workItems: sortWorkItems(parts.flatMap(p => p.workItems)),
    pullRequests: parts.flatMap(p => p.pullRequests),
    pipelines: sortPipelines(parts.flatMap(p => p.pipelines)),
    fetchedAt: now,
    errors,
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
