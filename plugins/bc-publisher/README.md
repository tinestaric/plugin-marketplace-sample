# BC Publisher

A Claude Code **mod** for Business Central developers: one view of the AL apps in your workspace and every environment you publish to, with **deterministic** compile and publish buttons. The agent gets the *same* functions as tools, so it can fix code, publish through the path the buttons use, read the result and iterate.

**Deterministic actions, agent as a peer user.** A button press runs code, never the model. The agent is invoked from the UI in one case only: **Ask agent to fix** after a failed compile or publish, and even then code has already trimmed the output to the actual diagnostics.

**Production is visible and impossible to publish to**, by button, by tool, or by shell (see the guard below). A SaaS target whose type cannot be determined is treated as production.

**One tool does the work: the AL tool (`altool`).** Compile is `altool compile` and publish is `altool publishapp`, for local containers, on-prem servers and SaaS sandboxes alike. There is no BcContainerHelper, no PowerShell and no hand-rolled token or upload code.

```
core/                 host-neutral Node (ES modules, Node 20+, no npm deps) — knows nothing about Claude Code
  index.js            createPublisher(io, { workspaceRoot }) -> discoverApps, discoverEnvironments,
                      compileApp, publishApp, getLastRun, buildErrorPrompt, toolStatus
  apps.js envs.js     app.json / .code-workspace discovery; launch.json + docker containers + SaaS merged
  compile.js          `altool compile` (alc.exe as fallback), diagnostics parsing, ruleset/analysers
  publish.js          production guard and `altool publishapp` arguments for every target kind
  runs.js             ~/.bc-publisher/runs.json (last 50) and the "ask agent to fix" prompt
  test/               node --test with in-memory fakes and a recorded real altool output
hooks/register.tsx    the thin adapter: /publish pane, band, five tools, shell guard
```

## Prerequisites

- The **AL tool**: `dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools` (installs the command `al`, shown as `altool` in its help). Its major version is the AL runtime it compiles; an older tool fails with `AL1043` on a newer app.
- **Docker** (optional): only to list local containers by their labels. Without it, a container still works when `launch.json` names it.
- **Azure CLI** (`az login`) (optional): only to list a tenant's environments from the Admin Center. Publishing to SaaS uses `altool`'s own login instead.

## Sign-in

| Target | How it authenticates |
| --- | --- |
| SaaS sandbox | `altool auth login` once (cached by the tool). In Claude Code type `! al auth login`. |
| Container / on-prem, `UserPassword` | Set `BC_SERVER_USERNAME` and `BC_SERVER_PASSWORD` in the environment **before starting Claude Code**. `altool` reads them itself; this mod never sees, stores or passes them. |
| On-prem, `Windows` | Your Windows identity; set `"authentication": "Windows"` in `launch.json`. |

## Install

```text
claude --plugin-dir ./plugins/bc-publisher
```

or `/plugin install bc-publisher --marketplace <owner>/<repo>`.

## Configure

`~/.bc-publisher/config.json` (created with an example on first run; no secrets):

```json
{
  "tenants": [{ "id": "<tenant guid>", "label": "Customer A", "domain": "customera.onmicrosoft.com" }],
  "environments": [
    { "id": "container:bc28", "agentMayPublish": true },
    { "id": "onprem:myserver/bc", "allowPublish": true }
  ],
  "adminApiVersion": "v2.29"
}
```

- **Apps**: every `app.json` under the workspace (honouring a `.code-workspace` file, skipping `.alpackages` and `node_modules`), ordered base apps first.
- **Environments** are merged from three sources into one list: `.vscode/launch.json` in each app, local containers (`docker ps` labels) and the Admin Center API for each configured tenant. A launch.json `server` that names a local container folds into that container, and its port, instance and authentication come from launch.json.
- **`agentMayPublish`**: the agent publishes to a container or on-prem server only when its entry says so. SaaS sandboxes always ask the person.
- **`allowPublish`**: a launch.json on-prem server is not a container and could be anyone's production system, so it is blocked until its entry says `"allowPublish": true`.
- **`isProduction: true`** on any entry makes it read-only. A config entry can only make a target safer.

## Using it

- **`/publish`** opens the pane: tick apps, **Compile** a row, **Publish (n)** the ticked apps to a card, **Publish all**. Choose the sync mode (`Add` = Synchronize by default, `ForceSync`) in the header; a launch.json `schemaUpdateMode` is the default for its target. Output streams live with `queued → compiling → publishing → done/failed`, and **Cancel** kills the child process.
- **Band above the prompt**, only while a job runs or just after one fails: `⠹ Publishing Base → bc28 · 00:41`, or `✗ Publish failed: 3 errors · [1] Ask agent to fix`.
- **Failure**: the log collapses to parsed diagnostics `{ severity, code, file, line, column, message }`. **Ask agent to fix** sends the app, target, command, diagnostics and the instruction to fix and publish again with the publisher tool. Missing symbols are reported exactly (`AL1022`) with the fix.
- **Agent tools**: `publisher_list_apps`, `publisher_list_environments` (includes `isProduction`), `publisher_compile(appPath)`, `publisher_publish(appPath, environmentId, mode?)`, `publisher_last_run(environmentId)`.
- **Guard (bonus)**: a `tool.call` hook on Bash and PowerShell. A command containing `Publish-BcContainerApp`, `Publish-NAVApp` or a `/dev/apps` URL is denied: production (or an unknown SaaS type) with a hard reason, anything else with a steer to `publisher_publish`, so every publish goes through one audited path.
- Without a display (`claude -p`), `/publish` returns apps and environments as text, and `/publish compile <app>` / `/publish publish <app|all> <environmentId>` work.

## Develop

```text
node --test core/test/          # discovery, parsing, publish flow against fakes
claude plugin validate .
claude plugin test .            # pane on every surface, tools, confirmation, guard, text fallback
```

## 60-second demo

1. `claude --plugin-dir ./plugins/bc-publisher`, then `/publish`. Apps on top, containers, SaaS sandboxes and a red, locked **Production** group below.
2. Tick the base app, press **Publish** on your v28 container. Watch the stage chips and live output; the band mirrors it above the prompt.
3. Break a line of AL and publish again. The log collapses to `AL0118 Sales.al(12,5) …` with **Ask agent to fix**.
4. Press it. The agent edits the file and calls `publisher_publish` itself. The pane shows the run it triggered (`agent`), now green.
5. Ask the agent to run `Publish-BcContainerApp` directly: the guard denies it and points to the tool. Ask it to publish to Production: refused.

## Verified live, and not

Run end to end with the real `altool` 18.0.41 (via a real-I/O harness around `core/`, with a throwaway app that was removed afterwards):

- **Container (BC 28, UserPassword):** discovery from `docker ps` labels merged with `launch.json`; symbols downloaded from the container's dev service (5 packages, following dependencies); compile; `publishapp`; republishing the same version works without `--forceupgrade`.
- **SaaS sandbox:** `publishapp` reused the existing VS Code sign-in (no `auth login` needed) and sent the request to `https://api.businesscentral.dynamics.com/v2.0/{environment}/dev/apps?tenant={tenant}&SchemaUpdateMode=…`.
- **Admin Center listing** (`/admin/v2.29/applications/BusinessCentral/environments`): returned the tenant's four environments (type, status, version, country) and merged with the `launch.json` entry for the same sandbox; a `CreatingFailed` sandbox is shown but not publishable.
- **Failure paths:** missing symbols (`AL1022`) and a compile error (`AL0118` with line and column) are parsed and handed to **Ask agent to fix**.

Not verified:

- **On-prem** (a non-container server) and **Windows** authentication: the arguments are built and tested, but no such server was available.
- The pane and band **in a live Claude Code session**: covered by `claude plugin test`, not yet by eye.
- Installed-app versions on a target are not shown (`altool` has no listing command), and SaaS symbols cannot be downloaded here (use `AL: Download Symbols` in VS Code).
- `~/.bc-publisher` is a shared folder name: if another tool keeps a differently-formatted `runs.json` there, this mod leaves it alone and writes `runs.altool.json` beside it.
