export type App = {
  id: string
  name: string
  publisher: string
  version: string
  path: string
  dependsOn: string[]
}

export type Environment = {
  id: string
  label: string
  kind: 'container' | 'saas' | 'onprem'
  sources: string[]
  isProduction: boolean
  type?: 'Production' | 'Sandbox'
  agentMayPublish?: boolean
  allowPublish?: boolean
  details: { bcVersion?: string; country?: string; state?: string; name?: string; server?: string }
}

export type Diagnostic = { severity: string; code: string; file: string | null; line: number | null; column: number | null; message: string }

export type Run = {
  id: string
  appId: string
  appName: string
  appVersion: string
  appPath: string
  environmentId: string
  environmentLabel: string
  requestedBy: string
  startedAt: number
  durationMs: number
  stage: string
  ok: boolean
  diagnostics: Diagnostic[]
  tail: string[]
  command?: string
  error?: string
  missingSymbols?: boolean
}

export type Stage = 'queued' | 'compiling' | 'publishing' | 'done' | 'failed'

export type Job = {
  id: string
  title: string
  environmentId: string | null
  stage: Stage
  startedAt: number
  /** Where a batch publish is: "2/3". */
  progress: string
  lines: string[]
  run: Run | null
  requestedBy: string
}

declare module 'claude-code' {
  interface PluginState {
    'bc-publisher': {
      workspace: string
      alcVersion: string | null
      apps: App[]
      environments: Environment[]
      selected: string[]
      lastRuns: Record<string, { ok: boolean; at: number; app: string; version: string }>
      sourceErrors: { source: string; message: string }[]
      isLoading: boolean
      syncMode: string
      job: Job | null
      /** Redraw counter while a job runs (spinner, elapsed time). */
      tick: number
      showLog: boolean
      isBandDismissed: boolean
    }
  }
}
