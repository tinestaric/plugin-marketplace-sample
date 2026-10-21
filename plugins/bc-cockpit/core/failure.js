import { resolveLocalRepo } from './repos.js'

export const MAX_LOG_CHARS = 8000
const AL_DIAGNOSTIC = /\b(error|warning) AL\d{4}\b/
const TEST_FAIL_START = /(Error Message:|Test (?:Failure|failed)|\[FAIL\]|^\s*Failure\b|##\[error\].*(?:test|codeunit))/i
const strip = line => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\u001b\[[0-9;]*m/g, '')

/**
 * Keeps what matters from one step's log:
 *  - AL compiler diagnostics (error/warning ALxxxx, with their file paths)
 *  - test failure blocks (error message, call stack), up to the next blank line
 *  - otherwise the last 40 lines.
 */
export function trimStepLog(text) {
  const lines = text.split(/\r?\n/).map(strip)
  const out = []

  for (const line of lines) {
    if (AL_DIAGNOSTIC.test(line)) out.push(line.trim())
  }

  for (let i = 0; i < lines.length; i++) {
    if (!TEST_FAIL_START.test(lines[i]) || AL_DIAGNOSTIC.test(lines[i])) continue
    const block = [lines[i]]
    // include the codeunit/method header just above, then the message and call stack below
    for (let b = i - 1; b >= Math.max(0, i - 2) && /codeunit|method|test/i.test(lines[b]); b--) block.unshift(lines[b])
    let j = i + 1
    while (j < lines.length && block.length < 16 && (lines[j].trim() !== '' || /call stack/i.test(lines[j - 1] ?? ''))) block.push(lines[j++])
    out.push(block.join('\n').trimEnd())
    i = j
  }

  if (out.length === 0) return lines.slice(-40).join('\n').trim()
  return [...new Set(out)].join('\n')
}

/** Joins per-step trims, newest-useful first, capped at ~8 KB. */
export function trimLogs(steps, max = MAX_LOG_CHARS) {
  let text = steps.map(s => `### ${s.name}\n${s.log}`).join('\n\n')
  if (text.length > max) text = text.slice(0, max - 60).trimEnd() + '\n… (truncated; see the full log in the build)'
  return text
}

export async function getFailureDetails(io, client, repoRoots, { org, project, buildId }) {
  const e = encodeURIComponent
  const base = `https://dev.azure.com/${e(org)}/${e(project)}/_apis/build/builds/${buildId}`
  const [build, timeline] = await Promise.all([
    client.request(`${base}?api-version=7.1`),
    client.request(`${base}/timeline?api-version=7.1`),
  ])

  const failed = (timeline.records ?? [])
    .filter(r => r.result === 'failed' && r.log?.url && r.type === 'Task')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  const steps = []
  for (const record of failed) {
    let log = ''
    try {
      log = trimStepLog(await client.request(record.log.url, { raw: true }))
    } catch (err) {
      log = `(could not fetch log: ${err.message})`
    }
    steps.push({ name: record.name, log })
  }

  const repo = build.repository?.name
  const remote = `https://dev.azure.com/${e(org)}/${e(project)}/_git/${e(repo ?? '')}`
  const localPath = await resolveLocalRepo(io, repoRoots, remote)

  return {
    org,
    project,
    repo,
    pipeline: build.definition?.name,
    branch: (build.sourceBranch ?? '').replace(/^refs\/heads\//, ''),
    buildId,
    buildUrl: build._links?.web?.href ?? `https://dev.azure.com/${e(org)}/${e(project)}/_build/results?buildId=${buildId}`,
    failedSteps: steps.map(s => s.name),
    trimmedLog: trimLogs(steps),
    localPath,
    commit: build.sourceVersion,
  }
}

export function buildFixPrompt(f) {
  const where = f.localPath
    ? `The local clone is at ${f.localPath}.`
    : 'No local clone was found, so ask where the repository lives before changing anything.'
  return [
    `The pipeline "${f.pipeline}" failed on branch ${f.branch} at commit ${(f.commit ?? '').slice(0, 10)} (${f.org}/${f.project}, repo ${f.repo}, build ${f.buildId}: ${f.buildUrl}).`,
    `Failing steps: ${f.failedSteps.join(', ') || '(none recorded)'}.`,
    '',
    'Trimmed errors:',
    '```',
    f.trimmedLog || '(no log output)',
    '```',
    '',
    `${where} Check out the branch, reproduce if possible, fix it, and summarise what you changed. Do not push.`,
  ].join('\n')
}
