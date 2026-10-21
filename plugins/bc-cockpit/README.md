# BC Cockpit

A Claude Code **mod** for Business Central developers who work across many Azure DevOps projects (and organisations) at once. It answers one question first, *what needs me right now?*, then shows your current sprint, and turns a red pipeline into a one-click, well-prepared hand-off to the agent.

**Code first, agent last.** Fetching, filtering, matching repos to local clones, and pulling and trimming failure logs are all plain code. The agent only sees a short, specific prompt at the very end. The cockpit is **read-only**: it never changes anything in Azure DevOps.

```
core/                 host-neutral Node (ES modules, Node 20+, no npm deps) — knows nothing about Claude Code
  index.js            createCockpit(io) -> { loadConfig, getBoard, getFailureDetails, buildFixPrompt, resolveLocalRepo }
  attention.js        what needs you, in order: one list for the band, the pane and the text output
  board.js azdo.js    fetching (current sprint per team, PRs, builds), scope filtering, change detection
  failure.js          timeline -> failed steps -> trimmed logs (~8 KB) -> fix prompt
  repos.js            Azure DevOps remote URL normalisation + local clone lookup
  test/               node --test against recorded JSON fixtures
hooks/register.tsx    the thin mod adapter: band, /cockpit pane, tools, injects $.* as `io`
```

## Install

```text
/plugin install bc-cockpit --marketplace <owner>/<repo>
```

Prerequisites: the Azure CLI signed in (`az login`) or an `AZDO_PAT` environment variable. Starting `az` can take 15–20 s on a machine with many accounts; the mod waits for it.

## Configure

`~/.bc-cockpit/config.json` is created with an example on first `/cockpit`. It never holds secrets, and may contain `//` comments.

```json
{
  "organisations": [
    { "name": "my-org", "projects": "*" },
    { "name": "customer-org", "projects": ["CustomerA-BC", "CustomerB-BC"] }
  ],
  "repoRoots": ["C:/Repos", "D:/Customers"],
  "refreshMinutes": 3,
  "pipelineScope": "mine",
  "failureMaxAgeDays": 7
}
```

- `"projects": "*"` discovers every project in the organisation.
- `pipelineScope`: `"mine"` = runs requested by me, or on a source branch or `refs/pull/<id>/merge` of my open PRs; `"all"` lists every pipeline (the *needs you* list still only nags about mine).
- `failureMaxAgeDays` (default 7): a red build older than this is history, not news.
- `closedStates` (optional): states treated as finished. Default `["Done", "Closed", "Removed", "Completed", "Cut"]`; WIQL cannot filter on state *category*, so it is by name.
- `repoRoots`: folders whose direct children are git clones. Used to find the local clone for **Fix**; nothing is ever cloned automatically.

Authentication: `az account get-access-token` for the Azure DevOps resource first, then `AZDO_PAT` (Basic auth). Tokens are held in memory only. If neither works the cockpit shows the exact command to run.

## What you get

**The band above the prompt is quiet when nothing needs you.** When something does:
`✗ 2 failed · ⚠ 1 PR in trouble · ◔ 1 to review`, with a button per item. The digits `1`–`5` open the same numbered item in the pane. If a board could not be loaded it says `⚠ incomplete`, never "all clear".

**`/cockpit` opens the pane** (manually, it never opens by itself):

```
BC Cockpit  updated 1m ago                                  [r] Refresh

NEEDS YOU (4)
1: ✗ Demo - Build                                  2h  [Fix]
     org/Project · demo/broken-build — src/A.al(5,9): error AL0118: The name 'Foo' does not exist
2: ⚠ !48 Reword the status line                    3h  open
     org/Project · demo/conflict — merge conflicts
3: ◔ !52 Add retry                                 1d  open
     org/Project · feature/retry — waiting on your review
4: ✓ !50 Add project notes                         1d  open
     org/Project · demo/approved — approved: ready to complete

Sprint 43 (Oct 19 - Oct 30) · Personal backlog · ends in 9d
▶ Task #81  Use Amount (LCY) consistently …                 P1
○ Issue #80 Customer statement shows wrong running balance  P1
▸ 1 done

▸ Other PRs (3)
▸ Pipelines (3 finished)
```

- **Needs you**, in this order: a failed pipeline of mine, my PR with conflicts / a failed build / changes requested, a PR waiting on my review, my approved PR ready to complete. A failure row shows its error inline. Press the number (or click) to open the trimmed log; **Fix** hands it to the agent. Drafts never nag; a PR whose red build is already a pipeline row is not listed twice.
- **Your sprint**: only your items in the *current sprint of the teams you are on*, one block per project, in progress first, finished work folded. There is no fallback: a project with no current sprint (or where you are on no team) contributes nothing.
- **Everything else is folded away**, and things that changed between refreshes are highlighted for 20 s.
- **Fix** submits a prompt with the failing steps, the trimmed errors (compiler `error ALxxxx`, test failure blocks, last 40 lines otherwise) and the local clone path. **Fix in background** spawns a subagent in the clone. Both need a local clone under `repoRoots`; without one the row says `no clone`.
- **Agent tools** (read-only): `cockpit_get_board` (needs-you list, sprint, PRs, pipelines), `cockpit_get_failure(buildId, org, project)`, `cockpit_refresh`.
- Without a display (`claude -p`), `/cockpit` returns the same board as text, needs-you first.

## Develop

```text
node --test core/test/          # core logic against fixtures, no network
claude plugin validate .
claude plugin test .            # adapter: pane on every surface, band, tools, text fallback
```

## 60-second demo

1. `/cockpit`. The first thing you see is what needs you, with the actual error under the red pipeline.
2. Press `1`: the trimmed log opens. Nothing here involved the model.
3. Click **Fix**. The prompt already holds the error and the local path, so the agent goes straight to the branch. No "go find out what's wrong".
4. Look at the sprint block: your items for this sprint, one line each, with the days left.
5. Ask *"what needs me?"*: the agent calls `cockpit_get_board` instead of browsing Azure DevOps.

## Verified, and not

Run against live Azure DevOps organisations (sandboxes): the work item, sprint, PR and build queries; the failure hand-off, including the log trimming and local clone lookup. The fake service in the tests now rejects invalid WIQL the way the real one does.

Not yet seen: the pane and band drawn in a live session (they are covered by `claude plugin test`, which checks structure, not paint), and a very large organisation (hundreds of projects): sprints are fetched per project, six at a time, and cached for half an hour.
