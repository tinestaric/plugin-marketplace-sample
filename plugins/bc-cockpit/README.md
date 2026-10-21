# BC Cockpit

A Claude Code **mod** for Business Central developers who work across many Azure DevOps projects (and organisations) at once. One view of everything assigned to you, every PR you're involved in, and every pipeline that broke, with a one-click hand-off of a red pipeline to the agent.

**Code first, agent last.** Fetching, filtering, matching repos to local clones, and pulling and trimming failure logs are all plain code. The agent only sees a short, specific prompt at the very end. The cockpit is **read-only**: it never changes anything in Azure DevOps.

```
core/                 host-neutral Node (ES modules, Node 20+, no npm deps) — knows nothing about Claude Code
  index.js            createCockpit(io) -> { loadConfig, getBoard, getFailureDetails, buildFixPrompt, resolveLocalRepo }
  board.js azdo.js    fetching, scope filtering, change detection
  failure.js          timeline -> failed steps -> trimmed logs (~8 KB) -> fix prompt
  repos.js            Azure DevOps remote URL normalisation + local clone lookup
  test/               node --test against recorded JSON fixtures
hooks/register.tsx    the thin mod adapter: band, /cockpit pane, tools, injects $.* as `io`
```

## Install

```text
claude --plugin-dir ./plugins/bc-cockpit
```

or from the marketplace in this repo: `/plugin install bc-cockpit --marketplace <owner>/<repo>`.

Prerequisites: Node-free at runtime (the mod runs inside Claude Code), and either the Azure CLI signed in (`az login`) or an `AZDO_PAT` environment variable.

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
  "pipelineScope": "mine"
}
```

- `"projects": "*"` discovers every project in the organisation.
- `pipelineScope`: `"mine"` = runs requested by me, or on a source branch or `refs/pull/<id>/merge` of my open PRs; `"all"` = latest run of every definition.
- `closedStates` (optional): work item states treated as finished. Default `["Done", "Closed", "Removed", "Completed", "Cut"]`; WIQL cannot filter on state *category*, so it is by name. Work items are fetched only for the projects you list.
- The band says `⚠ incomplete` (never `all green`) when any organisation or project failed to load.
- `repoRoots`: folders whose direct children are git clones. Used to find the local clone for **Fix with agent**; nothing is ever cloned automatically.

Authentication: `az account get-access-token` for the Azure DevOps resource first, then `AZDO_PAT` (Basic auth). Tokens are held in memory only. If neither works the cockpit shows the exact command to run.

## What you get

- **Band above the prompt:** `● 2 failed · 3 PRs waiting on you · 11 work items`, plus a button per failed pipeline with digit hotkeys `1`, `2`, … that opens its details.
- **`/cockpit` pane:** *My work* (grouped by project, priority then recency), *My PRs* ("Waiting on me" / "Mine", with vote, build and merge-conflict flags), *Pipelines* (failures first, then running; succeeded collapsed). Things that changed between refreshes (a pipeline going red, a PR getting approved) are highlighted for 20 s.
- **Fix with agent** submits a prompt containing the failing steps, the trimmed errors (compiler `error ALxxxx`, test failure blocks, last 40 lines otherwise) and the local clone path. **Fix in background** spawns a subagent in the clone instead. Both are unavailable (with the reason shown) when no clone is found.
- **Agent tools** (read-only): `cockpit_get_board`, `cockpit_get_failure(buildId, org, project)`, `cockpit_refresh`.
- Without a display (`claude -p`), `/cockpit` returns the board as text and the tools still work.

## Develop

```text
node --test core/test/          # core logic against fixtures, no network
claude plugin validate .
claude plugin test .            # adapter: pane on every surface, band, tools, text fallback
```

## 60-second demo

1. `claude --plugin-dir ./plugins/bc-cockpit`, then `/cockpit`. The board paints from cache, then refreshes. Point out two projects (or two organisations) in one view.
2. In the band, press `1` on the red pipeline: the trimmed compiler/test errors appear inline. Nothing here involved the model.
3. Click **Fix with agent**. The session prompt already holds the errors and the local path, so the agent goes straight to checking out the branch and fixing it. No "go find out what's wrong".
4. Ask: *"which of my PRs are waiting on me?"*. The agent calls `cockpit_get_board` instead of browsing Azure DevOps.
5. Re-run with `-p "/cockpit"` to show the same board as plain text.

## Not yet verified against live Azure DevOps

The endpoints are written against the REST API 7.1 docs and exercised with recorded fixtures, but no run against a real organisation has been done. Expect small field-level fixes (for example `requestedFor` filtering, AL test-log formats) on first live use.
