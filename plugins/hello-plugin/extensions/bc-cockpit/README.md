# BC Cockpit

A quick overview for a Business Central developer working across **many Azure DevOps projects and organisations**:

- **Sprint**: the work items assigned to you in the sprint that's running *today*. Projects with nothing for you in a current sprint don't show up.
- **Pull requests**: the PRs you created or review. Each one shows whether it has merge conflicts and whether its pipeline passed or failed.
- **One click to an agent session**: **Resolve conflicts** or **Investigate failure** starts a new agent session in your local clone, with everything it needs already prepared.

Every row opens in your browser.

**Code first, agent last.** Fetching, filtering to the current sprint, matching repos to local clones, listing conflicting files, and pulling and trimming failure logs are all plain code. The agent only gets a short, precise prompt at the end.

## Layout

```
bc-cockpit/
├── core/                 host-neutral Node (ESM, Node 20+, built-in fetch, no deps, no Copilot imports)
│   ├── index.mjs         loadConfig · getBoard · getFailureDetails · getConflictDetails · buildFixPrompt · buildConflictPrompt · resolveLocalRepo
│   ├── config.mjs        ~/.bc-cockpit/config.json (JSONC), first-run starter file
│   ├── auth.mjs          az CLI bearer token → AZDO_PAT fallback, in-memory cache only
│   ├── azdo.mjs          REST client (api-version 7.1, retry once on 401)
│   ├── board.mjs         current-sprint work items, PRs with merge + pipeline status
│   ├── failure.mjs       failed run → failed steps → logs → trimmed AL diagnostics/test failures (≤ 8 KB)
│   ├── conflicts.mjs     PR → conflicting files, branches, commits
│   ├── repos.mjs         remote URL normalisation + local clone discovery
│   └── test/             node --test suite with recorded-shape JSON fixtures
├── extension.mjs         Copilot canvas adapter (the only host-specific file)
├── server.mjs            127.0.0.1 HTTP + SSE server for the UI
├── open.mjs              open an Azure DevOps link in the default browser
└── ui/                   index.html · styles.css · app.js
```

## Install

This canvas ships inside **hello-plugin** in the `sample-marketplace` (`extensions/bc-cockpit/`). Installing the plugin installs the canvas:

```powershell
copilot plugin marketplace add tinestaric/plugin-marketplace-sample   # once per machine
copilot plugin install hello-plugin@sample-marketplace               # or: copilot plugin update hello-plugin
```

You can also install it from the Copilot app or VS Code plugin UI. Then start a new session (or reload extensions) and open it with **`/bc-cockpit`** or *"open BC Cockpit"*. See *Opening the canvas* below.

There's no `npm install`: the Copilot runtime provides `@github/copilot-sdk`, and `core/` has no dependencies.
### Prerequisites

- Azure CLI signed in: `az login`. The cockpit requests a token for the Azure DevOps resource `499b84ac-1321-427f-aa17-267ca6975798` from az's **current** account, so switching az to another tenant switches the cockpit too.
- Fallback: an `AZDO_PAT` environment variable with read scopes for Work Items, Code, Build and Project.

Tokens are held in memory only. They are never written to disk or sent to the UI.

## Configuration

`~/.bc-cockpit/config.json` (JSONC). It is created on first run and seeded with the organisations you belong to. It never holds secrets.

```jsonc
{
  "organisations": [
    { "name": "companial", "projects": "*" },                          // every project in the org
    { "name": "customer-org", "projects": ["CustomerA-BC", "CustomerB-BC"] }
  ],
  "repoRoots": ["C:/Repos", "D:/Customers"],   // scanned one level deep to find local clones for PRs
  "refreshMinutes": 3,
  "sprintOnly": true                           // false = every open work item assigned to you
}
```

The last board is cached in `~/.bc-cockpit/cache.json`, so the canvas paints instantly. The cache is versioned and written atomically.

## What it shows

| Area | Contents |
| --- | --- |
| **Sprint** | Open work items assigned to `@Me` in a sprint whose start/finish dates include today, one collapsible block per project (with its sprint and working days left), so items from different customers never mix. Sorted by priority. Undated iterations never count as current. Click a row (or press Enter) to open it in the browser. |
| **Pull requests** | Collapsible sections: *Needs attention* (merge conflicts or a failed pipeline), *Waiting on your review*, and *Open* (collapsed by default). Open/closed state is remembered. Each row shows project · repo · !id, the title, and a status line: merge conflicts, pipeline passed/failed/running, review state, and draft. |

**Pipeline status** comes from the PR's latest validation run on `refs/pull/N/merge`, falling back to the latest run on its source branch. Azure DevOps doesn't run validation builds while a PR has conflicts, so those show *No pipeline*.

**Agent buttons** on a PR are disabled, with the reason, when no local clone is found under `repoRoots`:

- **Resolve conflicts**: code fetches the conflicting files and both branches, then starts a new agent session in a worktree of the clone. That session merges the target into the source branch, resolves the conflicts, makes sure the result compiles, and commits. It does not push.
- **Investigate failure**: code fetches the failing steps and the trimmed AL errors or test failures, then starts a new agent session that checks out the PR's real source branch and fixes the problem. It does not push.

Extensions can't create sessions themselves, so the canvas asks the current agent to call its `create_session` tool with the prepared title, workspace, worktree flag and prompt. If the host has no such tool, the agent says so and offers to do the work in the current session.

Rows glide to their new place when a refresh reorders them. Anything whose status changed since you last looked flashes with a short label, for example *pipeline failed*, *conflicts*, *Approved* or a state change. Light and dark follow the host, and motion respects `prefers-reduced-motion`.

Errors in a single project never break the board. They are collected under the ⚠ indicator in the header.

## Agent tools (canvas actions, all read-only)

| Action | Input | Returns |
| --- | --- | --- |
| `cockpit_get_board` | – | Compact JSON: sprint items and PRs (conflicts, pipeline state, clone available) |
| `cockpit_get_failure` | `{ buildId, org, project }` | `{ org, project, repo, branch, buildId, buildUrl, failedSteps, trimmedLog, localPath, commit, prId }` |
| `cockpit_get_conflicts` | `{ org, project, repoId, prId }` | `{ sourceBranch, targetBranch, files, sourceCommit, targetCommit, localPath, url, … }` |
| `cockpit_refresh` | – | Forces a refresh and returns counts |

The cockpit never changes anything in Azure DevOps. The only non-GET calls are the read-only WIQL query and `workitemsbatch` lookups.

## Notes on the Azure DevOps API

- `System.StateCategory` is **not** a WIQL field (it fails with TF51005). The cockpit reads state categories from each organisation's process definitions, excludes unambiguously closed states in WIQL, and resolves ambiguous ones per project and work item type.
- The current sprint is read from the project's iteration tree (`classificationnodes/Iterations`) using its dates, so it doesn't depend on which team you're in.
- PR validation builds run on `refs/pull/N/merge`. For failure hand-off the cockpit uses the PR's real source branch and head commit, because the merge commit doesn't exist in a local clone.

## Tests

```powershell
cd <plugin>/extensions/bc-cockpit/core
node --test
```

The tests run fully offline against `core/test/fixtures/`.

## Sharing with your team

Canvases are Copilot **extensions**. Where the extension folder lives decides who gets it:

| Location | Who gets it |
| --- | --- |
| `~/.copilot/extensions/<name>/` | Only you, in every session. |
| `<repo>/.github/extensions/<name>/` | Everyone who opens **that** repo, and only in sessions for that repo. |
| A **plugin** whose `plugin.json` has `"extensions": "extensions"` (this one: `hello-plugin`) | Everyone who **installs the plugin**, in every session. |

Installing is a one-time, per-person step (see Install), not automatic. Updates arrive with `copilot plugin update hello-plugin`. Personal settings stay on each machine: `~/.bc-cockpit/`, `~/.bc-publisher/`, plus each person's own `az login`.

Don't keep a second copy in `~/.copilot/extensions/bc-cockpit`. Both copies would register the same canvas ID.

## Opening the canvas

- **Slash command:** type `/bc-cockpit` in the chat. The extension registers this command itself and opens the canvas directly, without an agent turn.
- **Plain request:** *"open BC Cockpit"*. The agent sees the canvas in its catalog and calls `open_canvas`.
- **Reopen:** the same request focuses the existing panel, with its state kept.
- **Agent tools:** the agent can also use the canvas actions (listed above) on its own, once the canvas is open.
## 60-second demo

1. **(0:00)** *"Open the BC Cockpit canvas."* The header reads *9 sprint items in Sprint 43 · 17 PRs · 5 need attention*. Only the current sprint is shown, across every organisation.
2. **(0:10)** Click a sprint row: it opens in the browser.
3. **(0:20)** **Needs attention**: !2 shows *✗ Pipeline failed*, and !3 shows *⚠ Merge conflicts*.
4. **(0:30)** On !2, click **Investigate failure**. A new agent session starts in a worktree of the local clone. Its prompt already contains the failing step and `error AL0297 … '50199'`, so the agent goes straight to the fix.
5. **(0:45)** On !3, click **Resolve conflicts**. A second session starts, already knowing that `src/Statement/StatementBalance.Codeunit.al` conflicts between `fix/statement-running-balance` and `main`.
