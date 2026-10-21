export type Pipeline = {
  org: string
  project: string
  buildId: number
  definitionId: number
  definition: string
  branch: string
  repo: string
  state: 'running' | 'succeeded' | 'failed' | 'canceled' | 'queued'
  finished: string
  requestedFor: string
  url: string
  localPath?: string | null
}

export type PullRequest = {
  org: string
  project: string
  id: number
  title: string
  repo: string
  source: string
  target: string
  isDraft: boolean
  isMine: boolean
  isReviewer: boolean
  myVote: number | null
  vote: 'rejected' | 'waiting' | 'approved' | 'partial' | 'none'
  mergeStatus: string
  build: Pipeline['state'] | null
  created: string
  url: string
}

export type WorkItem = {
  org: string
  project: string
  id: number
  title: string
  type: string
  state: string
  iteration: string
  priority: number
  changed: string
  url: string
}

export type Board = {
  workItems: WorkItem[]
  pullRequests: PullRequest[]
  pipelines: Pipeline[]
  fetchedAt: number
  errors: { org: string; scope: string; message: string }[]
  changed?: string[]
}

export type Failure = {
  buildId: number
  pipeline: string
  failedSteps: string[]
  trimmedLog: string
  localPath: string | null
  buildUrl: string
}

/** A failure's details, fetched deterministically on demand. */
export type Detail = { failure: Failure } | { error: string }

declare module 'claude-code' {
  interface PluginState {
    'bc-cockpit': {
      board: Board | null
      isRefreshing: boolean
      /** Item key -> epoch ms until which it is highlighted as "just changed". */
      changed: Record<string, number>
      /** Failure details by build id, shown inline. */
      details: Record<string, Detail>
      expanded: string | null
      showSucceeded: boolean
      showErrors: boolean
    }
  }
}
