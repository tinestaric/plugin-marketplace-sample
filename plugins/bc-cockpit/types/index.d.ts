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
  /** Requested by me, or on a branch (or PR merge ref) of one of my open PRs. */
  isMine?: boolean
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
  /** The state counts as finished (Done, Closed, ...). */
  isClosed: boolean
  iteration: string
  /** Name of the current sprint it belongs to. */
  sprint: string | null
  priority: number
  changed: string
  url: string
}

/** The current iteration of a team I am on, in a project where I have work in it. */
export type Sprint = { org: string; project: string; name: string; path: string; team: string; start: string | null; finish: string | null }

export type Board = {
  workItems: WorkItem[]
  sprints: Sprint[]
  pullRequests: PullRequest[]
  pipelines: Pipeline[]
  fetchedAt: number
  errors: { org: string; scope: string; message: string }[]
  changed?: string[]
  settings?: { failureMaxAgeDays?: number }
}

/** One thing that needs the person: the same list, in the same order, in the band, the pane and the text output. */
export type Attention = {
  key: string
  kind: 'pipeline' | 'pr-problem' | 'pr-review' | 'pr-ready'
  title: string
  where: string
  branch?: string
  reason: string
  at?: string
  url: string
  pipeline?: Pipeline
  pr?: PullRequest
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
      /** Failure details by org/project/build, fetched ahead for the first few failures so the row can show the error. */
      details: Record<string, Detail>
      /** The attention item opened in the pane (its log, or its link). */
      expanded: string | null
      /** Which collapsed groups are open: done, prs, pipelines. */
      sections: Record<string, boolean>
      showErrors: boolean
    }
  }
}
