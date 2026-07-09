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
  skills/                           shared by both tools
    hello-skill/SKILL.md            flat: no category subfolders
  agents-copilot/                   Copilot agent definitions (*.agent.md)
  agents-claude/                    Claude Code agent definitions (*.agent.md)
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

## Shared vs duplicated

- **Shared**: `skills/`, `.mcp.json`. Both tools read these files unchanged.
- **Duplicated**: agents. Copilot (`agents-copilot/*.agent.md`) and Claude Code
  (`agents-claude/*.agent.md`) use different frontmatter and tool-naming schemes (e.g.
  Copilot's `edit` = Claude's `Edit` + `Write`; Copilot's `search` = Claude's `Grep` +
  `Glob`), so each agent exists as two files with the same body but different
  frontmatter.
- If your plugin needs MCP servers, add a `.mcp.json` (top-level key `mcpServers`)
  at the plugin root — both tools read it unchanged, same as `skills/`.

## How each tool loads the plugin

- **Copilot** reads `plugins/hello-plugin/plugin.json`, which lists `skills` from
  `skills/` and, since agent auto-discovery from a custom folder isn't reliable, an
  explicit `agents` array pointing at each file in `agents-copilot/`. Marketplace
  manifest: `.github/plugin/marketplace.json`.
- **Claude Code** reads `plugins/hello-plugin/.claude-plugin/plugin.json`. Skills are
  picked up by folder convention from `skills/`, but agents need the same explicit
  treatment as Copilot: an `agents` array in the manifest listing each file in
  `agents-claude/`. Marketplace manifest: `.claude-plugin/marketplace.json`.
- Bottom line: neither tool reliably auto-discovers agents from a non-default folder.
  Both `plugin.json` files list their agent files explicitly, one entry per agent.
  Only `plugin.json` files live inside a `.claude-plugin/` folder; `skills/`,
  `agents-copilot/`, `agents-claude/`, and `.mcp.json` all sit at the plugin root.

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
3. Replace `agents-claude/hello-agent.agent.md` and `agents-copilot/hello-agent.agent.md`
   with your real agents — keep the body identical between the two, only the
   frontmatter differs per tool — and add each new file to both `plugin.json`
   `agents` arrays.
4. Update `examples/user-settings.*.jsonc` with your repo's path and plugin name.
