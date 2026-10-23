// Phase definitions. Prompt placeholders: {{feature}} {{specPath}} {{designPath}} {{notes}}

export type Phase = {
  id: string
  title: string
  icon: string
  goal: string
  prompt: string
  checklist: string[]
  snippets: string[]
  /** Work that changes code: a worktree agent lands on another branch. */
  writesCode?: boolean
}

export const PHASES: Phase[] = [
  {
    id: 'spec',
    title: 'Spec',
    icon: '1',
    goal: "Pin down what we're building and why, and what 'done' means.",
    prompt: `We're starting the SPEC phase for the feature: "{{feature}}".

Interview me to build a clear product spec. Use the AskUserQuestion tool, one question at a time, about: the problem, target users, goals, scope and non-goals, acceptance criteria, edge cases and constraints.

When we're aligned, write a concise spec to {{specPath}} with sections: Problem, Goals, Non-goals, User stories, Acceptance criteria (testable), Edge cases, Open questions.
Do NOT write any code in this phase.`,
    checklist: [
      'Problem and goals are clear',
      'Non-goals / scope boundaries listed',
      'Acceptance criteria are testable',
      'Open questions resolved or parked',
      'Spec written to artifacts folder',
    ],
    snippets: [
      'Challenge my assumptions: what am I missing?',
      'List the riskiest unknowns in this spec.',
      'Tighten the acceptance criteria so each one is verifiable.',
    ],
  },
  {
    id: 'design',
    title: 'Tech design',
    icon: '2',
    goal: 'Decide how to build it, grounded in the actual codebase.',
    prompt: `We're in the TECH DESIGN phase for "{{feature}}". Read the spec at {{specPath}}.

Explore the codebase (use the Explore agent for broad searches) to find the relevant modules, existing patterns and conventions. Then write a technical design to {{designPath}} covering:
- Approach and architecture
- Files/modules to add or change
- Data model / API / contract changes
- Alternatives considered and why they were rejected
- Risks, migration and rollout concerns
- Test strategy
- A numbered, step-by-step implementation plan

Ask me before committing to any significant design decision. Do NOT implement yet.`,
    checklist: [
      'Relevant code explored',
      'Approach agreed',
      'Alternatives considered',
      'Test strategy defined',
      'Step-by-step plan written',
    ],
    snippets: [
      "What's the simplest design that satisfies the spec?",
      'Compare two alternative approaches with trade-offs.',
      'Break the plan into small, independently verifiable steps.',
    ],
  },
  {
    id: 'implement',
    title: 'Implement',
    icon: '3',
    goal: 'Build it following the plan, with tests.',
    writesCode: true,
    prompt: `We're in the IMPLEMENT phase for "{{feature}}".
Follow the implementation plan in {{designPath}} (spec: {{specPath}}).

- Track the plan steps as todos and work through them in order
- Follow existing code conventions; keep changes surgical
- Add or update tests alongside the code
- Build and run the relevant tests as you go

When done, summarize what changed, any deviations from the design and why, and anything left open.`,
    checklist: ['All plan steps implemented', 'Tests added/updated', 'Build passes', 'Tests pass'],
    snippets: [
      'Pause and show me progress against the plan.',
      'Run the build and tests and report failures.',
      "Stick to the design, don't expand scope.",
    ],
  },
  {
    id: 'iterate',
    title: 'Iterate',
    icon: '4',
    goal: 'Verify against the spec, polish, and fix gaps.',
    writesCode: true,
    prompt: `We're in the ITERATE phase for "{{feature}}".

1. Re-run the build and tests.
2. Walk through every acceptance criterion in {{specPath}} and state whether it's met, with evidence.
3. List bugs, gaps, rough edges, missing error handling and missing tests you find.
4. Propose fixes, ordered by importance, and wait for my go-ahead before making large changes.`,
    checklist: [
      'Every acceptance criterion verified',
      'Edge cases handled',
      'No known bugs left',
      'Manual smoke test done',
    ],
    snippets: [
      'Fix the top issue you found.',
      'Add tests for the edge cases.',
      'Simplify: is there anything we can delete?',
      'Update docs/README for this change.',
    ],
  },
  {
    id: 'review',
    title: 'Code review',
    icon: '5',
    goal: 'Get a critical second pair of eyes on the diff.',
    prompt: `We're in the CODE REVIEW phase for "{{feature}}".

Run the code-review skill on all changes on this branch versus the base branch. Focus on real problems: bugs, logic errors, security issues, race conditions, missing tests, and deviations from the design in {{designPath}}. Ignore pure style nits.

Report findings as a table: severity, file, lines, issue, suggested fix. Then wait for me to pick which ones to fix.`,
    checklist: ['Review completed', 'Blocking findings fixed', 'Tests still pass after fixes'],
    snippets: [
      'Fix all high-severity findings.',
      'Run a security-focused review.',
      'Re-review after the fixes.',
    ],
  },
  {
    id: 'pr',
    title: 'Pull request',
    icon: '6',
    goal: 'Package it up and ship it.',
    prompt: `We're in the PR phase for "{{feature}}".

1. Make sure all changes are committed with a clear commit message and nothing unintended is included.
2. Create a pull request with a concise title and a description that covers: the problem (from {{specPath}}), the approach (from {{designPath}}), key changes, how it was tested, and any follow-ups.
Share the PR link when done.`,
    checklist: ['Working tree clean & committed', 'PR description written', 'PR created'],
    snippets: [
      "Draft the PR description only, don't create it yet.",
      'Create it as a draft PR.',
      'List follow-up items as issues.',
    ],
  },
]
