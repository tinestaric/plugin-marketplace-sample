# plugin-marketplace-sample

A minimal, working reference for structuring an internal plugin marketplace that
**both GitHub Copilot (VS Code) and Claude Code** can install from a single repo.
Contains one placeholder plugin, `hello-plugin` (one skill, one agent) — swap in
your own skills/agents and this structure carries over unchanged.

## Structure

```
.github/plugin/marketplace.json      Copilot marketplace manifest
.claude-plugin/marketplace.json      Claude marketplace manifest (identical content)
plugins/hello-plugin/
  plugin.json                       Copilot plugin manifest (plugin root)
  .claude-plugin/plugin.json        Claude plugin manifest
  agents/                           shared by both tools, default folder, no overrides needed
    hello-agent.agent.md
  skills/                           shared by both tools
    hello-skill/SKILL.md            flat: no category subfolders
  .mcp.json                         MCP servers, shared by both tools
examples/
  user-settings.claude.jsonc    goes in your Claude Code user settings (~/.claude/settings.json)
  user-settings.copilot.jsonc   goes in your VS Code user settings.json
README.md
```

Both tools expect their marketplace manifest at the **repo root** — neither supports
a manifest nested in a subfolder of the repo, so `.claude-plugin/` and
`.github/plugin/` must live here, not inside `plugins/` or any other subdirectory.

`skills/` must stay flat: Claude Code only discovers `SKILL.md` one level directly
under `skills/`, i.e. `skills/<skill-name>/SKILL.md`, never a category subfolder
in between. (Individual skill folders can nest whatever they want inside themselves,
just not another layer of skill folders.)

## One shared `agents/` folder, not two

Earlier revisions of this repo tried a folder per tool (`agents-copilot/`,
`agents-claude/`), each listed explicitly in its own `plugin.json`, to work around
Copilot and Claude Code naming their built-in tools differently. That broke in
practice: the Copilot **CLI** only reads the first `plugin.json` it finds, but the
Copilot extension **inside VS Code** reads every `plugin.json` in the plugin folder
and merges them — so VS Code ended up installing both agent sets at once, duplicates
and all.

The fix is to not need two sets in the first place. `agents/hello-agent.agent.md`
doesn't declare a restrictive tool list, so there's nothing that differs between
platforms and nothing to duplicate. Both `plugin.json` files stay at their defaults
(`agents/`, `skills/`), no path overrides, no per-file `agents` arrays.

## Shared, not duplicated

- **Shared**: `agents/`, `skills/`, `.mcp.json`. Both tools read these files
  unchanged — nothing in this repo is written twice.
- If your plugin needs MCP servers, add a `.mcp.json` (top-level key `mcpServers`)
  at the plugin root.

## How each tool loads the plugin

- **Copilot** reads `plugins/hello-plugin/plugin.json`. Marketplace manifest:
  `.github/plugin/marketplace.json`.
- **Claude Code** reads `plugins/hello-plugin/.claude-plugin/plugin.json`.
  Marketplace manifest: `.claude-plugin/marketplace.json`.
- Both pick up `agents/` and `skills/` by default, no path declared in either
  manifest. Only `plugin.json` files live inside a `.claude-plugin/` folder;
  `agents/`, `skills/`, and `.mcp.json` all sit at the plugin root.

## Install

Register the marketplace in **user settings**, not project or workspace settings:
it's a personal tool registration that should apply across every project you work
in, not something each consuming project's repo should have to declare or commit.

**Claude Code**

`enabledPlugins` in settings.json marks a plugin to auto-enable once installed; it
does not install it by itself.

1. Copy `examples/user-settings.claude.jsonc` into `~/.claude/settings.json` (strip
   the comments). This registers the marketplace.
2. Install the plugin: run `claude plugin install hello-plugin@sample-marketplace`,
   or `/plugin install hello-plugin@sample-marketplace` inside an interactive session.
3. Restart or reload Claude Code if it was already running.
4. Confirm it loaded: `claude plugin details hello-plugin@sample-marketplace` should
   list the skill and agent, or ask Claude to use `hello-agent` directly.

**Copilot (VS Code)**

Registering the marketplace does not install the plugin by itself; it only makes
`hello-plugin` available to pick.

1. Confirm agent plugin support is available (currently Preview; check your
   organisation's `chat.plugins.enabled` policy).
2. Add the marketplace via `chat.plugins.marketplaces` in your VS Code **user**
   settings.json, as shown in `examples/user-settings.copilot.jsonc`.
3. Open the Extensions view (`Ctrl+Shift+X` / `Shift+Cmd+X`), filter with
   `@agentPlugins` (or use the `...` menu > Views > Agent Plugins).
4. Find `hello-plugin` and click **Install**. On the first plugin from this
   marketplace, VS Code prompts you to confirm you trust the source.
5. Confirm it installed: it should appear under **Agent Plugins - Installed**, and
   its slash commands/agents should be available in Copilot Chat. If it doesn't show
   up, reload the window (`Developer: Reload Window`).

## Adapting this for your own plugin

1. Rename `plugins/hello-plugin/` and update both `marketplace.json` files'
   `plugins[].name`/`source` to match.
2. Replace `skills/hello-skill/` with your real skills (one `SKILL.md` per folder,
   flat under `skills/`).
3. Replace `agents/hello-agent.agent.md` with your real agents. Keep the frontmatter
   free of a restrictive `tools` list, that's what lets one file work for both
   Copilot and Claude Code without duplicating it.
4. Update `examples/user-settings.*.jsonc` with your repo's path and plugin name.
