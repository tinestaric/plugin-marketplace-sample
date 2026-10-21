import { joinPath, parseJsonc } from './util.js'

// JSON has no comments, so the example carries its explanations as `_comment` keys.
export const EXAMPLE_CONFIG = {
  _comment: 'BC Cockpit config. Never put secrets here: sign in with `az login` or set AZDO_PAT.',
  organisations: [
    { name: 'your-org', projects: '*', _comment: '"*" = every project in the organisation' },
    { name: 'customer-org', projects: ['CustomerA-BC', 'CustomerB-BC'] },
  ],
  repoRoots: ['C:/Repos'],
  _repoRootsComment: 'Folders whose direct children are git clones; used for "Fix with agent".',
  refreshMinutes: 3,
  pipelineScope: 'mine',
  _pipelineScopeComment: '"mine" = runs I requested or on branches of my open PRs; "all" = latest run of every definition',
}

const DEFAULTS = { organisations: [], repoRoots: [], refreshMinutes: 3, pipelineScope: 'mine', failureMaxAgeDays: 7 }

export const configDir = io => joinPath(io.home, '.bc-cockpit')
export const configPath = io => joinPath(configDir(io), 'config.json')

/** Reads ~/.bc-cockpit/config.json, writing the example on first run. */
export async function loadConfig(io) {
  const path = configPath(io)
  if (!(await io.fs.exists(path))) {
    await io.fs.write(path, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n')
    return { ...DEFAULTS, ...EXAMPLE_CONFIG, isExample: true, path }
  }
  let parsed
  try {
    // JSONC: people (and other tools) put comments in this file
    parsed = parseJsonc(await io.fs.read(path))
  } catch (e) {
    throw new Error(`Cannot parse ${path}: ${e.message}`)
  }
  const config = { ...DEFAULTS, ...parsed, path }
  config.refreshMinutes = Math.max(1, Number(config.refreshMinutes) || DEFAULTS.refreshMinutes)
  config.pipelineScope = config.pipelineScope === 'all' ? 'all' : 'mine'
  config.isExample = JSON.stringify(parsed.organisations) === JSON.stringify(EXAMPLE_CONFIG.organisations)
  return config
}
