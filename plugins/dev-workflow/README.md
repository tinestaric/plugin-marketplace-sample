# Dev workflow

A Claude Code **mod**: a pane that guides the **spec → tech design → implement → iterate → code review → PR** loop with buttons, so the workflow doesn't depend on the chat picking the right skill or agent. It is the Claude Code counterpart of the `dev-workflow` canvas in `hello-plugin` (GitHub Copilot).

## Install

```text
/plugin install dev-workflow --marketplace <owner>/<repo>
```

## Use

- `/dev-workflow <feature>` starts a workflow on the current git branch and opens the pane. `/dev-workflow` alone opens it. The pane opens by itself on a branch that already has a workflow.
- **Send to this chat** submits the phase's prompt (feature name and spec/design paths filled in). **Edit first** puts it in the prompt box instead. **Run in worktree agent** asks the chat to run the phase in an Agent with `isolation: "worktree"`.
- The exit-criteria checkboxes and the stepper only change saved state; **Next phase** with open criteria asks for a second press.
- While a branch is linked, every prompt you type carries the current phase and the spec/design paths as context.

## Where data lives

`<git-common-dir>/dev-workflow/workflows/<id>/workflow.json`, plus `spec.md` and `design.md` beside it. Shared by every worktree of the repo and never committed. Outside a git repo the pane says so and does nothing.

Phases and prompts are in `hooks/phases.ts`.
