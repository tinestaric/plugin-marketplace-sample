export type PhaseState = {
  status: 'todo' | 'active' | 'done'
  checks: Record<string, boolean>
  notes: string
}

export type HistoryEntry = { at: number; phase: string; text: string }

export type Workflow = {
  id: string
  feature: string
  branch: string
  currentPhase: string
  autoSendOnNext: boolean
  phases: Record<string, PhaseState>
  history: HistoryEntry[]
  updatedAt: number
}

export type WorkflowSummary = {
  id: string
  feature: string
  currentPhase: string
  branch: string
}

export type Artifacts = { dir: string; spec: boolean; design: boolean }

declare module 'claude-code' {
  interface PluginState {
    'dev-workflow': {
      /** The workflow linked to this session's branch, or null. */
      workflow: Workflow | null
      /** Every workflow of this repo, for linking. */
      others: WorkflowSummary[]
      artifacts: Artifacts | null
      branch: string | null
      isBusy: boolean
      /** Last guard confirmation armed ("next" | "nextSend" | ""). */
      armed: string
    }
  }
}
