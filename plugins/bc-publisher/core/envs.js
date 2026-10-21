import { GUID, errorMessage, parseJsonc } from './util.js'

export const ADMIN_API = 'v2.29' // current at time of writing; override with "adminApiVersion" in config
const BC_RESOURCE = 'https://api.businesscentral.dynamics.com'

/** Stable ids: container:<name>, saas:<tenant>/<environment>, onprem:<host>/<instance>. */
export const containerId = name => `container:${name.toLowerCase()}`
export const saasId = (tenant, env) => `saas:${String(tenant).toLowerCase()}/${String(env).toLowerCase()}`
export const onpremId = (server, instance) => `onprem:${String(server).toLowerCase().replace(/^https?:\/\//, '').replace(/[/:]+$/, '')}/${String(instance).toLowerCase()}`

// ── launch.json ───────────────────────────────────────────────────────────

/** AL configurations of one launch.json as environment entries. */
export function parseLaunch(text, source) {
  let json
  try {
    json = parseJsonc(text)
  } catch {
    return []
  }
  const out = []
  for (const c of json.configurations ?? []) {
    if (c.type !== 'al') continue
    const common = { label: c.name, source, schemaUpdateMode: c.schemaUpdateMode, authentication: c.authentication }
    if (c.environmentType === 'Sandbox' || c.environmentType === 'Production') {
      const tenant = c.tenant || 'default'
      out.push({
        ...common,
        id: saasId(tenant, c.environmentName ?? c.environmentType),
        kind: 'saas',
        type: c.environmentType,
        isProduction: c.environmentType === 'Production',
        details: { tenant, environmentName: c.environmentName },
      })
    } else if (c.server) {
      out.push({
        ...common,
        id: onpremId(c.server, c.serverInstance ?? 'BC'),
        kind: 'onprem',
        isProduction: false,
        details: {
          server: c.server,
          serverInstance: c.serverInstance ?? 'BC',
          port: c.port,
          tenant: c.tenant ?? 'default',
          authentication: c.authentication ?? 'UserPassword',
        },
      })
    }
  }
  return out
}

// ── containers (docker labels, no BcContainerHelper) ──────────────────────

const DOCKER_FORMAT = '{{.Names}}\t{{.State}}\t{{.Label "maintainer"}}\t{{.Label "nav"}}\t{{.Label "version"}}\t{{.Label "country"}}'

export async function listContainers(io) {
  const r = await io.run(['docker', 'ps', '-a', '--format', DOCKER_FORMAT], { timeoutMs: 30000 })
  if (r.exitCode !== 0) throw new Error(`docker: ${r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`}`)
  return parseContainers(r.stdout)
}

/** Rows of name, state, maintainer, nav, version, country (tab-separated). BC images say maintainer "Dynamics SMB"; older ones also set `nav`. */
export function parseContainers(stdout) {
  return stdout
    .split(/\r?\n/)
    .map(line => line.split('\t'))
    .filter(([name, , maintainer, nav]) => name && (/Dynamics SMB/i.test(maintainer ?? '') || nav))
    .map(([name, state, , , version, country]) => ({
      id: containerId(name),
      label: name,
      kind: 'container',
      source: 'docker',
      isProduction: false,
      details: {
        name,
        bcVersion: version,
        country,
        state: state === 'running' ? 'running' : state || 'unknown',
        server: `http://${name}`,
        serverInstance: 'BC',
        port: 7049,
        authentication: 'UserPassword',
        tenant: 'default',
      },
    }))
}

// ── SaaS ──────────────────────────────────────────────────────────────────

/** Token for the Admin Center API only (listing environments). Publishing uses altool's own login. */
export async function bcToken(io, tenant) {
  const args = ['account', 'get-access-token', '--resource', BC_RESOURCE, '--query', 'accessToken', '-o', 'tsv']
  if (tenant && tenant !== 'default') args.push('--tenant', tenant)
  let last
  // On Windows `az` is az.cmd, which no-shell process APIs cannot start: the last candidate goes through cmd.exe.
  for (const prefix of [['az'], ['az.cmd'], ['cmd.exe', '/d', '/c', 'az']]) {
    try {
      const r = await io.run([...prefix, ...args], { timeoutMs: 30000 })
      if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
      last = r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`
    } catch (e) {
      last = errorMessage(e)
    }
  }
  throw new Error(
    `Cannot list environments for tenant ${tenant} (${last}). Publishing is unaffected: targets from launch.json still work. ` +
      `To list them, sign in once: az login --allow-no-subscriptions --tenant ${tenant} --scope ${BC_RESOURCE}/.default`,
  )
}

export async function listSaas(io, tenant, apiVersion = ADMIN_API) {
  const token = await bcToken(io, tenant.id)
  const res = await io.fetch(`${BC_RESOURCE}/admin/${apiVersion}/applications/BusinessCentral/environments`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Admin API ${apiVersion} for ${tenant.label ?? tenant.id}: HTTP ${res.status}`)
  return parseSaas(JSON.parse(res.text), tenant)
}

export function parseSaas(json, tenant) {
  return (json.value ?? []).map(e => {
    const type = e.type === 'Production' || e.type === 'Sandbox' ? e.type : undefined
    return {
      id: saasId(tenant.id, e.name),
      label: `${tenant.label ?? tenant.id} · ${e.name}`,
      kind: 'saas',
      source: 'admin-center',
      type,
      // Production, and anything whose type cannot be determined, is never a publish target.
      isProduction: type !== 'Sandbox',
      details: {
        tenant: tenant.id,
        tenantLabel: tenant.label,
        environmentName: e.name,
        bcVersion: e.versionDetails?.version ?? e.applicationVersion,
        country: e.countryCode,
        state: e.status === 'Active' ? 'ready' : e.status,
      },
    }
  })
}

// ── merge ─────────────────────────────────────────────────────────────────

/** Folds launch.json targets into the live lists so one target appears once, with every source named. */
export function mergeEnvironments(launch, containers, saas, tenants = []) {
  const byId = new Map()
  const add = e => {
    const prev = byId.get(e.id)
    if (!prev) return byId.set(e.id, { ...e, sources: [e.source] })
    byId.set(e.id, {
      ...prev,
      ...Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== undefined && k !== 'details' && k !== 'isProduction')),
      details: { ...prev.details, ...Object.fromEntries(Object.entries(e.details ?? {}).filter(([, v]) => v !== undefined)) },
      // a known type from any live source beats a guess; production from any source wins
      isProduction: prev.isProduction || e.isProduction,
      sources: [...new Set([...prev.sources, e.source])],
    })
  }
  containers.forEach(add)
  saas.forEach(add)

  for (const l of launch) {
    let entry = l
    if (l.kind === 'saas') {
      // launch.json may name a tenant by domain; canonicalise to a configured tenant id
      const t = tenants.find(t => t.id === l.details.tenant || t.domain === l.details.tenant || t.label === l.details.tenant)
      if (t) entry = { ...l, id: saasId(t.id, l.details.environmentName), details: { ...l.details, tenant: t.id, tenantLabel: t.label } }
    } else if (l.kind === 'onprem') {
      // a launch.json "server" that is a local container is that container
      const host = l.details.server.replace(/^https?:\/\//, '').replace(/[:/].*$/, '').toLowerCase()
      const c = containers.find(c => c.details.name.toLowerCase() === host)
      if (c) entry = { ...l, id: c.id, kind: 'container', details: { ...c.details, ...l.details } }
    }
    add(entry)
  }
  return [...byId.values()].sort((a, b) => Number(a.isProduction) - Number(b.isProduction) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
}

export { GUID }
