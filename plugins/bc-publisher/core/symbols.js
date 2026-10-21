import { findAlTool, readApp } from './compile.js'
import { errorMessage, exec, joinPath, parseJsonc } from './util.js'

const MAX_PACKAGES = 40

/** Packages an app needs symbols for: the platform (System), the application, and its own dependencies. */
export function rootPackages(appJson) {
  const out = []
  if (appJson.platform) out.push({ publisher: 'Microsoft', name: 'System', version: appJson.platform })
  if (appJson.application) out.push({ publisher: 'Microsoft', name: 'Application', version: appJson.application })
  for (const d of appJson.dependencies ?? appJson.dependencies ?? []) {
    if (d.name && d.publisher) out.push({ publisher: d.publisher, name: d.name, version: d.version })
  }
  return out
}

const q = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The development service's package URL, as VS Code's "AL: Download Symbols" calls it. */
export function packageUrl(env, pkg) {
  const d = env.details
  const base = `${d.server.replace(/\/+$/, '')}${d.port ? `:${d.port}` : ''}/${d.serverInstance || 'BC'}`
  const params = new URLSearchParams({ publisher: pkg.publisher, appName: pkg.name, versionText: pkg.version, tenant: d.tenant || 'default' })
  return `${base}/dev/packages?${params}`
}

/**
 * Downloads the symbol packages an app needs into its .alpackages from a container or on-prem server, following
 * each package's own dependencies (read with `altool GetPackageManifest`). The download is curl, because a
 * package is a binary body that $.http.fetch cannot carry; credentials go on curl's stdin, never its command line.
 * Resolves { ok, downloaded: [...], failed: [...] }.
 */
export async function downloadSymbols(io, appPath, env, credentials, { onOutput, handle } = {}) {
  if (env.kind === 'saas') throw new Error('Symbols for a SaaS environment cannot be downloaded here: use "AL: Download Symbols" in VS Code, or download them from a container of the same version.')
  const tool = await findAlTool(io)
  if (!tool) throw new Error('The AL tool is needed to read package manifests: dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools')
  const auth = env.details.authentication === 'Windows' ? ['--negotiate', '-u', ':'] : []
  if (!auth.length && !(credentials?.user && credentials?.password)) {
    throw new Error('Set BC_SERVER_USERNAME and BC_SERVER_PASSWORD (UserPassword) before starting Claude Code, or use Windows authentication.')
  }

  const app = await readApp(io, appPath)
  const manifest = parseJsonc(await io.fs.read(joinPath(appPath, 'app.json')))
  const folder = joinPath(appPath, '.alpackages')
  const queue = rootPackages(manifest)
  const seen = new Set()
  const downloaded = []
  const failed = []

  while (queue.length && seen.size < MAX_PACKAGES) {
    const pkg = queue.shift()
    const key = `${pkg.publisher}|${pkg.name}`.toLowerCase()
    if (seen.has(key) || (pkg.publisher === app.publisher && pkg.name === app.name)) continue
    seen.add(key)
    const file = joinPath(folder, `${pkg.publisher}_${pkg.name}_${pkg.version}.app`.replace(/[\\/:*?"<>|]/g, '_'))
    onOutput?.(`↓ ${pkg.publisher} ${pkg.name} ${pkg.version}`)
    const input = [`url = ${q(packageUrl(env, pkg))}`, ...(auth.length ? [] : [`user = ${q(`${credentials.user}:${credentials.password}`)}`])].join('\n') + '\n'
    let r
    try {
      r = await exec(io, ['curl.exe', '-sS', '--fail', '--create-dirs', ...auth, '-K', '-', '-o', file], { input, handle })
    } catch (e) {
      failed.push({ ...pkg, error: errorMessage(e) })
      continue
    }
    if (r.cancelled) break
    if (r.code !== 0) {
      failed.push({ ...pkg, error: r.lines.at(-1) ?? `curl exit ${r.code}` })
      onOutput?.(`  ✗ ${r.lines.at(-1) ?? `exit ${r.code}`}`)
      continue
    }
    downloaded.push(pkg)
    // a package names its own dependencies: follow them so one click is enough
    const m = await io.run([tool.exe, 'GetPackageManifest', file], { timeoutMs: 30000 }).catch(() => null)
    if (m?.exitCode === 0) {
      try {
        for (const d of JSON.parse(m.stdout).dependencies ?? []) queue.push({ publisher: d.publisher, name: d.name, version: d.version })
      } catch {
        /* an unreadable manifest only costs the transitive step */
      }
    }
  }
  onOutput?.(`${downloaded.length} package(s) downloaded${failed.length ? `, ${failed.length} failed` : ''}`)
  return { ok: failed.length === 0 && downloaded.length > 0, downloaded, failed }
}
