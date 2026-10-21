# Dev workflow

A visual navigator for the **spec → tech design → implement → iterate → code review → PR** loop. GitHub Copilot only.

- One workflow per feature, linked to git branches. Every session and worktree on a linked branch sees the same progress.
- Each phase has a goal, a checklist and a prompt. **Send** puts the prompt into the current session. **Spin up session** starts a separate agent session for that phase in its own worktree.
- Phase prompts can use `{{feature}}`, `{{artifactsDir}}`, `{{specPath}}` and `{{designPath}}`.

## Where data lives

| Data | Location |
| --- | --- |
| Workflows of a git repo | `<git-common-dir>/dev-workflow/workflows/<id>/workflow.json`. Shared by every worktree, never committed. |
| Workflows outside a git repo | `~/.copilot/extension-data/dev-workflow/no-repo/` |
| Custom phases (optional) | `~/.copilot/extension-data/dev-workflow/phases.json`, a JSON array merged by `id` with the defaults in `phases.mjs`. New ids are appended; `"disabled": true` hides a phase. |

## Opening it

Ask the agent to *"open the dev workflow canvas"*. Asking again focuses the existing panel.

## Install

It ships in **hello-plugin**:

```powershell
copilot plugin marketplace add tinestaric/plugin-marketplace-sample   # once per machine
copilot plugin install hello-plugin@sample-marketplace               # or: copilot plugin update hello-plugin
```

Don't keep a second copy in `~/.copilot/extensions/dev-workflow`. Both copies would register the same canvas ID.
