import { errorMessage } from './util.js'

const API = '7.1'

/** Thin read-only Azure DevOps REST client. The only writes are WIQL/batch POSTs, which are queries. */
export function createClient(io, auth) {
  async function request(url, { method = 'GET', body, raw = false } = {}) {
    // build logs come back as a JSON envelope unless plain text is asked for
    const headers = { Authorization: await auth.authorization(), Accept: raw ? 'text/plain' : 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await io.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (res.status === 401 || res.status === 203) {
      auth.clear()
      throw new Error('Unauthorized (401): sign in again with `az login`')
    }
    if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*/, '')} -> HTTP ${res.status}`)
    if (raw) return res.text
    try {
      return JSON.parse(res.text)
    } catch {
      throw new Error(`Not JSON from ${url.replace(/\?.*/, '')} (is the organisation name right, and are you signed in?)`)
    }
  }
  const e = encodeURIComponent
  const q = (url, params = '') => `${url}${url.includes('?') ? '&' : '?'}${params ? params + '&' : ''}api-version=${API}`

  return {
    request,
    async me(org) {
      const d = await request(`https://dev.azure.com/${e(org)}/_apis/connectionData?api-version=${API}-preview`)
      return d.authenticatedUser.id
    },
    async projects(org) {
      const out = []
      let skip = 0
      for (;;) {
        const d = await request(q(`https://dev.azure.com/${e(org)}/_apis/projects`, `$top=100&$skip=${skip}`))
        out.push(...d.value.map(p => p.name))
        if (d.value.length < 100) return out
        skip += 100
      }
    },
    async workItems(org, { projects, closedStates } = {}) {
      const wiql = { query: workItemsQuery({ projects, closedStates }) }
      const res = await request(q(`https://dev.azure.com/${e(org)}/_apis/wit/wiql`, '$top=200'), { method: 'POST', body: wiql })
      const ids = (res.workItems ?? []).map(w => w.id)
      const items = []
      for (let i = 0; i < ids.length; i += 200) {
        const batch = await request(q(`https://dev.azure.com/${e(org)}/_apis/wit/workitemsbatch`), {
          method: 'POST',
          body: {
            ids: ids.slice(i, i + 200),
            fields: [
              'System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.TeamProject',
              'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'System.ChangedDate',
            ],
          },
        })
        items.push(...(batch.value ?? []).map(w => normaliseWorkItem(org, w)))
      }
      return items
    },
    async pullRequests(org, project, meId) {
      const base = `https://dev.azure.com/${e(org)}/${e(project)}/_apis/git/pullrequests`
      const [mine, review] = await Promise.all([
        request(q(base, `searchCriteria.status=active&searchCriteria.creatorId=${meId}&$top=100`)),
        request(q(base, `searchCriteria.status=active&searchCriteria.reviewerId=${meId}&$top=100`)),
      ])
      const byId = new Map()
      for (const pr of [...mine.value, ...review.value]) byId.set(pr.pullRequestId, pr)
      return [...byId.values()].map(pr => normalisePullRequest(org, project, pr, meId))
    },
    async prBuild(org, project, pr) {
      const url = q(
        `https://dev.azure.com/${e(org)}/${e(project)}/_apis/build/builds`,
        `branchName=${e(`refs/pull/${pr.id}/merge`)}&queryOrder=queueTimeDescending&$top=1&repositoryId=${e(pr.repoId)}&repositoryType=TfsGit`,
      )
      const d = await request(url)
      const b = d.value?.[0]
      return b ? buildState(b) : null
    },
    async builds(org, project) {
      const d = await request(q(`https://dev.azure.com/${e(org)}/${e(project)}/_apis/build/builds`, 'queryOrder=queueTimeDescending&$top=200'))
      return d.value ?? []
    },
    errorMessage,
  }
}

export function normaliseWorkItem(org, w) {
  const f = w.fields
  const project = f['System.TeamProject']
  return {
    org,
    id: w.id,
    title: f['System.Title'],
    type: f['System.WorkItemType'],
    state: f['System.State'],
    project,
    iteration: f['System.IterationPath'] ?? '',
    priority: f['Microsoft.VSTS.Common.Priority'] ?? 99,
    changed: f['System.ChangedDate'],
    url: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${w.id}`,
  }
}

// System.StateCategory is not a queryable WIQL field (TF51005), so closed work is excluded by state name.
// The names cover the Basic, Agile, Scrum and CMMI processes; "closedStates" in the config overrides them.
export const CLOSED_STATES = ['Done', 'Closed', 'Removed', 'Completed', 'Cut']
const lit = s => `'${String(s).replace(/'/g, "''")}'` // a WIQL string literal: quotes doubled

export function workItemsQuery({ projects, closedStates } = {}) {
  const closed = (closedStates?.length ? closedStates : CLOSED_STATES).map(lit).join(', ')
  let where = `[System.AssignedTo] = @Me AND [System.State] NOT IN (${closed})`
  // only the projects the config asks for: others must neither show up nor use the 200-item limit
  if (Array.isArray(projects) && projects.length) where += ` AND [System.TeamProject] IN (${projects.map(lit).join(', ')})`
  return `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`
}

/** Overall vote: the worst reviewer vote wins (rejected < waiting < none < approved-with-suggestions < approved). */
export function overallVote(reviewers = []) {
  const votes = reviewers.filter(r => !r.isContainer).map(r => r.vote ?? 0)
  if (votes.some(v => v === -10)) return 'rejected'
  if (votes.some(v => v === -5)) return 'waiting'
  if (votes.length && votes.every(v => v >= 5)) return 'approved'
  if (votes.some(v => v >= 5)) return 'partial'
  return 'none'
}

export function normalisePullRequest(org, project, pr, meId) {
  const mine = pr.createdBy?.id === meId
  const myReview = (pr.reviewers ?? []).find(r => r.id === meId)
  return {
    org,
    project,
    id: pr.pullRequestId,
    title: pr.title,
    repo: pr.repository?.name,
    repoId: pr.repository?.id,
    source: (pr.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
    target: (pr.targetRefName ?? '').replace(/^refs\/heads\//, ''),
    isDraft: !!pr.isDraft,
    isMine: mine,
    isReviewer: !!myReview,
    myVote: myReview ? myReview.vote : null,
    vote: overallVote(pr.reviewers),
    mergeStatus: pr.mergeStatus ?? 'notSet',
    created: pr.creationDate,
    build: null,
    url: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(pr.repository?.name ?? '')}/pullrequest/${pr.pullRequestId}`,
  }
}

/** 'running' | 'succeeded' | 'failed' | 'canceled' | 'queued' */
export function buildState(b) {
  if (b.status && b.status !== 'completed') return b.status === 'notStarted' ? 'queued' : 'running'
  if (b.result === 'succeeded') return 'succeeded'
  if (b.result === 'canceled') return 'canceled'
  return 'failed' // failed and partiallySucceeded both need attention
}

export function normaliseBuild(org, project, b) {
  return {
    org,
    project,
    buildId: b.id,
    definitionId: b.definition?.id,
    definition: b.definition?.name,
    branch: (b.sourceBranch ?? '').replace(/^refs\/heads\//, ''),
    sourceBranch: b.sourceBranch,
    repoId: b.repository?.id,
    repo: b.repository?.name,
    state: buildState(b),
    finished: b.finishTime ?? b.startTime ?? b.queueTime,
    requestedFor: b.requestedFor?.displayName,
    requestedForId: b.requestedFor?.id,
    url: b._links?.web?.href ?? `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_build/results?buildId=${b.id}`,
  }
}
