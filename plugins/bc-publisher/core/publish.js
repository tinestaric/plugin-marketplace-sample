import { findAlTool } from './compile.js'
import { exec } from './util.js'

const MODES = { Add: 'Synchronize', Synchronize: 'Synchronize', ForceSync: 'ForceSync', Recreate: 'Recreate' }
const LAUNCH_MODES = { synchronize: 'Add', forcesync: 'ForceSync', recreate: 'Recreate' }
const SERVER_NAME = /^https?:\/\/[A-Za-z0-9][\w.-]*(:\d+)?\/?$/

/**
 * Why a target can never be published to (null: it can).
 *  - Production, and a SaaS target whose type cannot be determined: never.
 *  - A server that is not a local container (launch.json "OnPrem"): could be anyone's production server, and
 *    nothing says it is not, so it needs `"allowPublish": true` on its entry in ~/.bc-publisher/config.json.
 */
export function publishBlock(env) {
  if (!env) return 'Unknown environment.'
  if (env.isProduction) return `${env.label} is a production environment. Publishing to production from this tool is not allowed.`
  if (env.kind === 'saas' && env.type !== 'Sandbox') return `${env.label}: the environment type could not be determined, so it is treated as production.`
  if (env.kind === 'saas' && env.details?.state && env.details.state !== 'ready') return `${env.label} is not ready (status: ${env.details.state}).`
  if (env.kind === 'onprem' && !env.allowPublish) {
    return `${env.label} is an on-premises server and may be a production system. To allow publishing, add { "id": "${env.id}", "allowPublish": true } to "environments" in ~/.bc-publisher/config.json.`
  }
  if (env.kind !== 'saas' && !SERVER_NAME.test(env.details?.server ?? '')) return `${env.label}: no usable server URL (expected http://host).`
  return null
}

/** Sync mode for a publish: explicit choice, else launch.json's schemaUpdateMode, else Add. */
export const defaultMode = env => LAUNCH_MODES[String(env?.schemaUpdateMode ?? '').toLowerCase()] ?? 'Add'

/** `altool publishapp` arguments for a target. Credentials never appear here: altool reads BC_SERVER_USERNAME/PASSWORD itself. */
export function publishArgs(env, appFile, mode = 'Add') {
  const args = ['publishapp', appFile, '--schemaupdatemode', MODES[mode] ?? 'Synchronize']
  const d = env.details ?? {}
  if (env.kind === 'saas') {
    args.push('--environmenttype', 'Sandbox', '--environmentname', d.environmentName)
    if (d.tenant && d.tenant !== 'default') args.push('--tenant', d.tenant)
  } else {
    args.push('--server', d.server, '--serverinstance', d.serverInstance || 'BC', '--environmenttype', 'OnPrem', '--tenant', d.tenant || 'default')
    if (d.port) args.push('--port', String(d.port))
    if (d.authentication) args.push('--authentication', d.authentication)
  }
  return args
}

const AUTH_HINT = /Authentication required|UserNotAuthenticated|401|Unauthorized/i

/** Publishes with `altool publishapp`. Same call for a local container, an on-prem server and a SaaS sandbox. */
export async function publishApp(io, env, appFile, { mode = 'Add', onOutput, handle } = {}) {
  const tool = await findAlTool(io)
  if (!tool) {
    return { ok: false, command: '(altool missing)', lines: [], error: 'The AL tool is not installed. Run: dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools' }
  }
  const args = publishArgs(env, appFile, mode)
  const r = await exec(io, [tool.exe, ...args], { onOutput, handle })
  const failedAuth = r.lines.some(l => AUTH_HINT.test(l))
  let error
  if (r.cancelled) error = 'cancelled'
  else if (r.code !== 0) {
    const reason = [...r.lines].reverse().find(l => /Publish failed/i.test(l))
    error = failedAuth
      ? env.kind === 'saas'
        ? 'Not signed in to Business Central. Run `altool auth login` (type: ! al auth login) and publish again.'
        : 'The server rejected the credentials. Set BC_SERVER_USERNAME and BC_SERVER_PASSWORD (UserPassword) before starting Claude Code, or use Windows authentication.'
      : reason?.trim() || 'publish failed'
  }
  return { ok: r.code === 0, cancelled: r.cancelled, command: `al ${args.join(' ')}`, lines: r.lines, error }
}
