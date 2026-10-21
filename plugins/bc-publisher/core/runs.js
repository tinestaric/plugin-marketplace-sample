import { joinPath } from './util.js'

const KEEP = 50
const dir = io => joinPath(io.home, '.bc-publisher')
export const runsPath = io => joinPath(dir(io), 'runs.json')
// ~/.bc-publisher is a shared, well-known folder: another tool may keep its own runs.json there in another
// format. This mod's file is a plain array; it never overwrites a file that is anything else.
const OWN_FALLBACK = io => joinPath(dir(io), 'runs.altool.json')

async function resolveRunsPath(io) {
  try {
    const parsed = JSON.parse(await io.fs.read(runsPath(io)))
    return Array.isArray(parsed) ? { path: runsPath(io), runs: parsed } : { path: OWN_FALLBACK(io), runs: await readArray(io, OWN_FALLBACK(io)) }
  } catch (e) {
    // a missing file is ours to create; a file that exists but cannot be parsed is not ours to replace
    const exists = await io.fs.exists(runsPath(io)).catch(() => false)
    return exists ? { path: OWN_FALLBACK(io), runs: await readArray(io, OWN_FALLBACK(io)) } : { path: runsPath(io), runs: [] }
  }
}

async function readArray(io, path) {
  try {
    const parsed = JSON.parse(await io.fs.read(path))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function readRuns(io) {
  return (await resolveRunsPath(io)).runs
}

/** Newest first, last 50 kept. */
export async function recordRun(io, run) {
  const { path, runs } = await resolveRunsPath(io)
  await io.fs.write(path, JSON.stringify([run, ...runs].slice(0, KEEP), null, 1))
  return run
}

export async function getLastRun(io, environmentId) {
  return (await readRuns(io)).find(r => r.environmentId === environmentId) ?? null
}

/**
 * The hand-off after a failure: app, target, command, diagnostics with file and line, and the instruction to
 * fix the code then publish again with the publisher tool (never by a script of its own).
 */
export function buildErrorPrompt(run) {
  const errors = (run.diagnostics ?? []).filter(d => d.severity === 'error')
  const shown = (errors.length ? errors : run.diagnostics ?? []).slice(0, 25)
  const diag = shown.length
    ? shown.map(d => `- ${d.file ? `${d.file}${d.line ? `(${d.line},${d.column ?? 1})` : ''}: ` : ''}${d.severity} ${d.code}: ${d.message}`).join('\n')
    : [run.error, ...(run.tail ?? []).slice(-20)].filter(Boolean).join('\n') || '(no output captured)'
  const compileOnly = !run.environmentId
  const what = `${run.appName ?? 'the app'} ${run.appVersion ?? ''}`.trim()
  const folder = run.appPath ?? 'the app folder'
  const head = compileOnly
    ? `Compiling ${what} failed.`
    : `Publishing ${what} to ${run.environmentLabel ?? run.environmentId} failed during ${run.stage ?? 'the run'}.`
  const next = compileOnly
    ? `Fix the code in ${folder}, then compile again with the mcp__bc-publisher__publisher_compile tool (appPath "${run.appPath ?? ''}") and read its diagnostics until it is clean.`
    : `Fix the code in ${folder}, then publish again with the mcp__bc-publisher__publisher_publish tool (appPath "${run.appPath ?? ''}", environmentId "${run.environmentId}"). Do not run Publish-BcContainerApp or call the dev endpoint yourself. Read the returned run record and iterate until it succeeds.`
  return [head, `Command: ${run.command ?? '(unknown)'}`, '', shown.length ? 'Diagnostics:' : 'Last output:', diag, '', next].join('\n')
}
