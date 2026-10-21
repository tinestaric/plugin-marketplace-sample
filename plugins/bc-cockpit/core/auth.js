import { base64, errorMessage } from './util.js'

const AZDO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const TOKEN_TTL_MS = 30 * 60 * 1000 // `az` does not print the expiry with `-o tsv`; refresh well before ~60 min.

export const SIGN_IN_HINT = `Not signed in. Run \`az login\` (or set the AZDO_PAT environment variable) and refresh.`

/**
 * Bearer token from the Azure CLI, falling back to AZDO_PAT as Basic auth.
 * The token lives in memory only: never written to disk or shown in the UI.
 */
export function createAuth(io) {
  let cached = null

  async function fromAz() {
    const args = ['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']
    let lastError
    // `az` is az.cmd on Windows, which no-shell process APIs cannot start: the last candidate goes through cmd.exe.
    for (const prefix of [['az'], ['az.cmd'], ['cmd.exe', '/d', '/c', 'az']]) {
      try {
        const r = await io.run([...prefix, ...args], { timeoutMs: 60000 })
        const token = r.stdout.trim()
        if (r.exitCode === 0 && token) return { header: `Bearer ${token}`, via: 'az' }
        lastError = r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`
      } catch (e) {
        lastError = errorMessage(e)
      }
    }
    throw new Error(lastError)
  }

  async function authorization() {
    if (cached && cached.expiresAt > io.now()) return cached.header
    let result
    try {
      result = await fromAz()
    } catch {
      const pat = await io.env('AZDO_PAT')
      if (!pat) throw Object.assign(new Error(SIGN_IN_HINT), { code: 'not-signed-in' })
      result = { header: `Basic ${base64(':' + pat)}`, via: 'pat' }
    }
    cached = { ...result, expiresAt: io.now() + TOKEN_TTL_MS }
    return cached.header
  }

  return { authorization, clear: () => (cached = null) }
}
