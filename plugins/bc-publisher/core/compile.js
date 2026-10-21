import { appFileName } from './apps.js'
import { compareVersions, errorMessage, exec, joinPath, parseJsonc } from './util.js'

const EXT_ROOTS = ['.vscode/extensions', '.vscode-insiders/extensions']
const ALC_PATHS = ['bin/win32/alc.exe', 'win32/alc.exe', 'bin/alc.exe']
const ALTOOL_CANDIDATES = home => ['al', 'altool', joinPath(home, '.dotnet/tools/al.exe'), joinPath(home, '.dotnet/tools/altool.exe')]
const ANALYZERS = {
  CodeCop: 'Microsoft.Dynamics.Nav.CodeCop.dll',
  UICop: 'Microsoft.Dynamics.Nav.UICop.dll',
  AppSourceCop: 'Microsoft.Dynamics.Nav.AppSourceCop.dll',
  PerTenantExtensionCop: 'Microsoft.Dynamics.Nav.PerTenantExtensionCop.dll',
}

/** The newest installed AL Language extension: { version, extensionDir } or null. */
export async function findExtension(io) {
  const found = []
  for (const root of EXT_ROOTS) {
    const dir = joinPath(io.home, root)
    let entries
    try {
      entries = await io.fs.list(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const m = e.kind === 'dir' && e.name.match(/^ms-dynamics-smb\.al-(\d+(?:\.\d+)*)/)
      if (m) found.push({ version: m[1], extensionDir: joinPath(dir, e.name) })
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}

/**
 * The AL tool (`altool`, installed as the dotnet tool `al`): `dotnet tool install -g
 * Microsoft.Dynamics.BusinessCentral.Development.Tools`. Returns { exe, version } or null.
 * One tool compiles (`compile` runs alc) and publishes (`publishapp`).
 */
export async function findAlTool(io) {
  for (const exe of ALTOOL_CANDIDATES(io.home)) {
    try {
      const r = await io.run([exe, '--version'], { timeoutMs: 20000 })
      const version = r.stdout.match(/\d+(?:\.\d+){1,3}/)?.[0]
      if (r.exitCode === 0 && version) return { exe, version }
    } catch {
      /* not this one */
    }
  }
  return null
}

/** altool if installed, else alc.exe from the AL extension. { argv: [...prefix], label, version } or null. */
export async function findCompiler(io) {
  const tool = await findAlTool(io)
  if (tool) return { argv: [tool.exe, 'compile'], label: 'altool', version: tool.version }
  const ext = await findExtension(io)
  if (ext) {
    for (const rel of ALC_PATHS) {
      const path = joinPath(ext.extensionDir, rel)
      if (await io.fs.exists(path)) return { argv: [path], label: 'alc', version: ext.version }
    }
  }
  return null
}

const DIAG = /^(?:(.*?)\((\d+),(\d+)(?:,\d+,\d+)?\):\s*)?(error|warning|info)\s+([A-Za-z]{2,}\d{3,4}):\s*(.*?)(?:\s+\[[^\]]*\])?\s*$/

/** compiler output -> [{ severity, code, file, line, column, message }] */
export function parseDiagnostics(lines) {
  const out = []
  for (const raw of lines) {
    const m = raw.trim().match(DIAG)
    if (!m) continue
    out.push({
      severity: m[4],
      code: m[5],
      file: m[1]?.trim() || null,
      line: m[2] ? Number(m[2]) : null,
      column: m[3] ? Number(m[3]) : null,
      message: m[6],
    })
  }
  return out
}

/** AL1022 (and AL1018, the package cache folder itself missing): "A package with publisher 'Microsoft', name 'System', and a version compatible with ... could not be found". */
export const isMissingSymbol = d => d.severity === 'error' && (d.code === 'AL1022' || d.code === 'AL1018')

/** Honours ruleset and analysers configured in .vscode/settings.json. */
export async function projectCompilerOptions(io, appPath, extension) {
  let settings = {}
  try {
    settings = parseJsonc(await io.fs.read(joinPath(appPath, '.vscode', 'settings.json')))
  } catch {
    /* none */
  }
  const args = []
  if (settings['al.ruleSetPath']) {
    const p = String(settings['al.ruleSetPath'])
    args.push(`/ruleset:${/^([A-Za-z]:|\/)/.test(p) ? p : joinPath(appPath, p)}`)
  }
  if (extension && (settings['al.enableCodeAnalysis'] || settings['al.codeAnalyzers'])) {
    for (const name of settings['al.codeAnalyzers'] ?? ['CodeCop']) {
      const dll = ANALYZERS[String(name).replace(/^\$\{|\}$/g, '')]
      const path = dll && joinPath(extension.extensionDir, 'bin', 'Analyzers', dll)
      if (path && (await io.fs.exists(path))) args.push(`/analyzer:${path}`)
    }
  }
  return args
}

export async function readApp(io, appPath) {
  const j = parseJsonc(await io.fs.read(joinPath(appPath, 'app.json')))
  return { id: j.id, name: j.name, publisher: j.publisher, version: j.version, path: appPath }
}

/** Compiles with `altool compile` (or alc.exe). Resolves a result even when compilation fails. */
export async function compileApp(io, appPath, { onOutput, handle } = {}) {
  const startedAt = io.now()
  const compiler = await findCompiler(io)
  if (!compiler) {
    return { ok: false, appFile: null, diagnostics: [], compiler: null, missingSymbols: false, tail: [], error: 'No AL compiler found. Install the AL tool: dotnet tool install -g Microsoft.Dynamics.BusinessCentral.Development.Tools' }
  }
  const app = await readApp(io, appPath)
  const outFile = joinPath(appPath, appFileName(app))
  const packages = joinPath(appPath, '.alpackages')
  const rest = [`/project:${appPath}`, `/packagecachepath:${packages}`, `/out:${outFile}`, ...(await projectCompilerOptions(io, appPath, await findExtension(io)))]
  const argv = [...compiler.argv, ...rest]

  onOutput?.(`${compiler.label} ${compiler.version}: ${rest.join(' ')}`)
  let result
  try {
    result = await exec(io, argv, { cwd: appPath, onOutput, handle })
  } catch (e) {
    return { ok: false, appFile: null, diagnostics: [], compiler, missingSymbols: false, tail: [], error: errorMessage(e) }
  }
  // altool prints paths relative to the project; the agent and the UI need ones they can open
  const diagnostics = parseDiagnostics(result.lines).map(d => (d.file && !/^([A-Za-z]:|[\\/])/.test(d.file) ? { ...d, file: joinPath(appPath, d.file) } : d))
  const errors = diagnostics.filter(d => d.severity === 'error')
  const ok = result.code === 0 && errors.length === 0
  return {
    ok,
    cancelled: result.cancelled,
    appFile: ok ? outFile : null,
    diagnostics,
    compiler: { label: compiler.label, version: compiler.version },
    missingSymbols: errors.some(isMissingSymbol),
    tail: result.lines.slice(-30),
    command: argv.join(' '),
    durationMs: io.now() - startedAt,
  }
}

/** True when the .app exists and is newer than every source file (so a publish may skip compiling). */
export async function isUpToDate(io, appPath, appFile) {
  let built
  try {
    built = (await io.fs.stat(appFile)).mtimeMs
  } catch {
    return false
  }
  const newest = async dir => {
    let latest = 0
    for (const e of await io.fs.list(dir)) {
      if (e.kind === 'dir') {
        if (['.alpackages', '.git', 'node_modules', 'out'].includes(e.name)) continue
        latest = Math.max(latest, await newest(joinPath(dir, e.name)))
      } else if (e.kind === 'file' && /\.(al|json|xlf|xml|rdlc|docx|png)$/i.test(e.name)) {
        latest = Math.max(latest, (await io.fs.stat(joinPath(dir, e.name))).mtimeMs)
      }
    }
    return latest
  }
  return built > (await newest(appPath))
}
