// Host-neutral helpers. No Node built-ins: all I/O arrives through `io`.

export const errorMessage = e => (e instanceof Error ? e.message : String(e))

export function joinPath(...parts) {
  return parts.join('/').replace(/\\/g, '/').replace(/(?<!^|:)\/{2,}/g, '/')
}
export const dirname = p => p.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
export const basename = p => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()

/** JSON with comments and trailing commas (launch.json, .code-workspace, settings.json). */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''))
}

/** Compares dotted versions numerically: -1, 0, 1. */
export function compareVersions(a, b) {
  const pa = String(a ?? '0').split('.').map(Number)
  const pb = String(b ?? '0').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** PowerShell single-quoted literal. */
export const psq = s => `'${String(s).replace(/'/g, "''")}'`

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Runs a streamed child via io.spawn and feeds complete lines to onOutput.
 * `handle.cancel()` kills the child. Resolves { code, cancelled, lines }.
 */
export async function exec(io, argv, { cwd, input, onOutput, handle } = {}) {
  const it = io.spawn(argv, { cwd, input })
  let cancelled = false
  if (handle) {
    handle.cancel = () => {
      cancelled = true
      return it.return?.()
    }
  }
  const pending = { stdout: '', stderr: '' }
  const lines = []
  const emit = line => {
    lines.push(line)
    onOutput?.(line)
  }
  let code = null
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) {
        code = r.value?.code ?? null
        break
      }
      const parts = (pending[r.value.stream] + r.value.text).split(/\r?\n/)
      pending[r.value.stream] = parts.pop()
      parts.forEach(emit)
    }
  } finally {
    for (const rest of Object.values(pending)) if (rest) emit(rest)
  }
  return { code: cancelled ? null : code, cancelled, lines }
}
