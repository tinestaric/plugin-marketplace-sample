# BC Publisher

One view of the AL apps in this workspace and every Business Central environment you publish to: local BcContainerHelper containers, SaaS sandboxes across tenants, and (shown only) on-prem servers. It has buttons that **compile and publish deterministically**.

The agent gets the **same** functions as tools. It can fix code, publish through the exact code path the buttons use, read the run record and iterate. The model never compiles or publishes by itself. It is invoked from the UI in exactly one case: **Ask agent to fix** after a failed run, with the output already trimmed to the parsed diagnostics.

## Layout

```
extensions/bc-publisher/          (inside hello-plugin)
├── core/                  host-neutral Node (ESM, Node 20+, no deps, no Copilot imports)
│   ├── index.mjs          discoverApps · discoverEnvironments · compileApp · publishApp · getLastRun · buildErrorPrompt
│   ├── apps.mjs           app.json discovery (.code-workspace aware) + dependency ordering
│   ├── environments.mjs   launch.json + Get-BcContainers + BC Admin Center API → one merged list, publish policy
│   ├── compiler.mjs       alc.exe discovery, arguments (ruleset/analysers), diagnostics parser
│   ├── publish.mjs        Publish-BcContainerApp script, SaaS dev endpoint upload
│   ├── runs.mjs           ~/.bc-publisher/runs.json (last 50, versioned, atomic)
│   ├── proc.mjs           streamed child processes, pwsh -EncodedCommand, process-tree cancel
│   └── test/              node --test suite + fixtures
├── extension.mjs          Copilot canvas adapter (the only host-specific file)
├── jobs.mjs               serial job queue: queued → compiling → publishing → done/failed, streamed logs
├── server.mjs             127.0.0.1 HTTP + SSE server for the UI
└── ui/                    index.html · styles.css · app.js
```

## Install

This canvas ships inside **hello-plugin** in the `sample-marketplace` (`extensions/bc-publisher/`). Installing the plugin installs the canvas:

```powershell
copilot plugin marketplace add tinestaric/plugin-marketplace-sample   # once per machine
copilot plugin install hello-plugin@sample-marketplace               # or: copilot plugin update hello-plugin
```

You can also install it from the Copilot app or VS Code plugin UI. Then start a new session (or reload extensions) and open it with **`/bc-publisher`** or *"open BC Publisher"*. See *Opening the canvas* below.

There's no `npm install`: the Copilot runtime provides `@github/copilot-sdk`, and `core/` has no dependencies.
### Prerequisites

| Tool | Used for |
| --- | --- |
| **AL Language extension** (VS Code or VS Code Insiders) | `alc.exe`. The newest installed version is used and shown in the header. |
| **PowerShell 7** (`pwsh`) | Every container operation |
| **BcContainerHelper** module | `Get-BcContainers`, `Publish-BcContainerApp`, `Restart-BcContainer`, `Compile-AppInBcContainer` |
| **Docker** reachable by your user | Containers (otherwise the cards say so) |
| **Azure CLI** (`az login`) | Tokens for the BC Admin Center API and the SaaS dev endpoint (`--tenant <id>`) |

## Configuration

`~/.bc-publisher/config.json` (JSONC). It's created on first run, seeded with your current az tenant, and never holds secrets.

```jsonc
{
  "tenants": [ { "id": "b1a41ebb-…", "label": "StarReach" } ],
  "environments": {
    "container:bc28": { "agentMayPublish": true }   // the agent may publish here without asking
  },
  "alcPath": null                                    // optional explicit alc.exe
}
```

`environments` may also be a list of `{ "id": …, "agentMayPublish": … }` entries. Environment ids are shown on every card (click to copy).

Runs are stored in `~/.bc-publisher/runs.json` (last 50). Each run looks like this: `{ id, kind, appId, appVersion, environmentId, startedAt, durationMs, ok, diagnostics, tail, … }`.

## Environments

Three sources are merged into one list. Each entry is `{ id, label, kind, source, details, isProduction, … }`:

1. **`.vscode/launch.json`** in each app folder (and the workspace root), AL `launch` configurations. Identical targets are de-duplicated. An `OnPrem` server whose host is a bare name (e.g. `http://bcdev`) is treated as a container.
2. **Local containers** via `Get-BcContainers`, with version/country (`Get-BcContainerNavVersion`), running state and the installed version of each workspace app (`Get-BcContainerAppInfo`).
3. **SaaS** via the BC Admin Center API (`/admin/v2.29/applications/environments`) for each configured tenant.

### Safety rules (enforced in `core/`, for buttons and tools alike)

- **Production is shown but can never be published to.** That covers both an Admin API type of `Production` and a launch.json `environmentType: "Production"`.
- **A SaaS target whose type can't be confirmed by the Admin API is refused.** That includes launch.json targets without `"tenant"`, tenants you can't sign in to, and tenants where you lack admin rights (HTTP 403). The card shows the exact reason.
- On-prem: shown, *not supported yet*.
- The agent (`publisher_publish`):
  - **SaaS sandbox**: the host asks you to confirm every time (`session.ui.confirm`).
  - **Container**: allowed only if its config entry has `"agentMayPublish": true`.
  - Production: always refused.
- Agent tools only accept app folders that discovery found in this workspace.

## Compile and publish

- Compile: `alc.exe /project: /packagecachepath: /out:` (plus `/ruleset:`, `/analyzer:` and `/assemblyprobingpaths:` from `.vscode/settings.json`). Diagnostics are parsed into `{ severity, code, file, line, column, message }`. Missing symbols (AL1022) are called out, with a **download from container** action (`Compile-AppInBcContainer -updateSymbols`).
- Publish always compiles first, unless `skipCompile` is set and the `.app` is newer than every source file.
  - **Container**: `Publish-BcContainerApp -skipVerification -sync -syncMode Add|ForceSync`. It adds `-upgrade` when an older version is installed, otherwise `-install`. An identical version is unpublished first (data kept).
  - **SaaS sandbox**: `POST https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}/dev/apps?SchemaUpdateMode=synchronize|forcesync`, with the `.app` as multipart form data. This is the same contract VS Code and BcContainerHelper use.
- Output streams live with ANSI stripped. Jobs run one at a time, are cancellable (the process tree is killed), and selections publish in dependency order, stopping at the first failure.

## Agent tools (canvas actions)

| Action | Input | Returns |
| --- | --- | --- |
| `publisher_list_apps` | – | Apps in dependency order |
| `publisher_list_environments` | – | Merged environments incl. `isProduction`, `publishable`, `agentMayPublish` |
| `publisher_compile` | `{ appPath }` | `ok`, parsed diagnostics, output file |
| `publisher_publish` | `{ appPath, environmentId, mode? }` | The run record (refuses production, with a reason) |
| `publisher_last_run` | `{ environmentId }` | Last publish run or `null` |

Agent-triggered jobs show up in the same live output panel, tagged *triggered by agent*.

## Tests

```powershell
cd <plugin>/extensions/bc-publisher/core
node --test
```

Covers discovery, ordering, diagnostics parsing, compiler discovery, environment merging, the publish policy, the run store and end-to-end publish flows, all against fixtures and fakes with no network, Docker or alc.exe.

## Sharing with your team

Canvases are Copilot **extensions**. Where the extension folder lives decides who gets it:

| Location | Who gets it |
| --- | --- |
| `~/.copilot/extensions/<name>/` | Only you, in every session. |
| `<repo>/.github/extensions/<name>/` | Everyone who opens **that** repo, and only in sessions for that repo. |
| A **plugin** whose `plugin.json` has `"extensions": "extensions"` (this one: `hello-plugin`) | Everyone who **installs the plugin**, in every session. |

Installing is a one-time, per-person step (see Install), not automatic. Updates arrive with `copilot plugin update hello-plugin`. Personal settings stay on each machine: `~/.bc-cockpit/`, `~/.bc-publisher/`, plus each person's own `az login`.

Don't keep a second copy in `~/.copilot/extensions/bc-publisher`. Both copies would register the same canvas ID.

## Opening the canvas

- **Slash command:** type `/bc-publisher` in the chat. The extension registers this command itself and opens the canvas directly, without an agent turn. Add a folder to target another workspace: `/bc-publisher C:/Repos/customer-app`.
- **Plain request:** *"open BC Publisher"*. The agent sees the canvas in its catalog and calls `open_canvas`.
- **Reopen:** the same request focuses the existing panel, with its state kept.
- **Agent tools:** the agent can also use the canvas actions (listed above) on its own, once the canvas is open.
## 60-second demo

1. **(0:00)** *"Open the BC Publisher canvas."* Apps on the left in dependency order, environment cards in the middle: local containers, SaaS sandboxes per tenant, and a striped, locked Production card.
2. **(0:10)** Tick the base app and press **Publish** on a container card. The stepper moves queued → compiling → publishing → done, and the log streams.
3. **(0:20)** Break a line of AL and publish again. The run stops at *compiling*, and the log collapses to the parsed `AL0118` with file and line.
4. **(0:30)** Click **Ask agent to fix**. The agent gets the app, target, command and diagnostics, fixes the code, and calls `publisher_publish`.
5. **(0:50)** The card flashes green: *Last publish OK · by agent*. Ask it to publish to Production. It refuses, and so does the button.
