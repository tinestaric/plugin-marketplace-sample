import { basename, compareVersions, dirname, joinPath, parseJsonc } from './util.js'

const SKIP = new Set(['.alpackages', 'node_modules', '.git', '.snapshots', '.altestrunner', 'out', 'bin', 'obj'])
const MAX_DEPTH = 6

/** Folders to scan: the `.code-workspace` folders if one exists in the root, else the root itself. */
export async function workspaceFolders(io, root) {
  let entries = []
  try {
    entries = await io.fs.list(root)
  } catch {
    return [root]
  }
  const ws = entries.find(e => e.kind === 'file' && e.name.endsWith('.code-workspace'))
  if (!ws) return [root]
  try {
    const parsed = parseJsonc(await io.fs.read(joinPath(root, ws.name)))
    const folders = (parsed.folders ?? []).map(f => (/^([A-Za-z]:|\/)/.test(f.path) ? f.path : joinPath(root, f.path)))
    return folders.length ? folders : [root]
  } catch {
    return [root]
  }
}

async function findAppJsons(io, dir, depth, out) {
  let entries
  try {
    entries = await io.fs.list(dir)
  } catch {
    return
  }
  if (entries.some(e => e.kind === 'file' && e.name === 'app.json')) out.push(dir)
  if (depth >= MAX_DEPTH) return
  for (const e of entries) {
    if (e.kind === 'dir' && !SKIP.has(e.name)) await findAppJsons(io, joinPath(dir, e.name), depth + 1, out)
  }
}

export async function discoverApps(io, workspaceRoot) {
  const dirs = []
  for (const folder of await workspaceFolders(io, workspaceRoot)) await findAppJsons(io, folder, 0, dirs)
  const apps = []
  for (const dir of [...new Set(dirs)]) {
    try {
      const j = parseJsonc(await io.fs.read(joinPath(dir, 'app.json')))
      apps.push({
        id: j.id,
        name: j.name,
        publisher: j.publisher,
        version: j.version,
        runtime: j.runtime,
        idRanges: j.idRanges ?? (j.idRange ? [j.idRange] : []),
        dependencies: (j.dependencies ?? []).map(d => ({ id: d.id ?? d.appId, name: d.name, publisher: d.publisher, version: d.version })),
        path: dir,
        folder: basename(dir),
      })
    } catch {
      /* unreadable app.json: skipped, never fatal */
    }
  }
  return orderByDependencies(apps)
}

/** Base apps first. Only dependencies between the discovered apps matter; cycles fall back to input order. */
export function orderByDependencies(apps) {
  const byId = new Map(apps.map(a => [a.id, a]))
  const sorted = []
  const state = new Map() // 1 visiting, 2 done
  const visit = a => {
    if (state.get(a.id) === 2 || state.get(a.id) === 1) return
    state.set(a.id, 1)
    for (const d of a.dependencies) {
      const dep = byId.get(d.id)
      if (dep) visit(dep)
    }
    state.set(a.id, 2)
    sorted.push(a)
  }
  [...apps].sort((a, b) => a.name.localeCompare(b.name)).forEach(visit)
  return sorted.map(a => ({
    ...a,
    dependsOn: a.dependencies.filter(d => byId.has(d.id)).map(d => byId.get(d.id).name),
  }))
}

/** The `.app` file name alc produces. */
export const appFileName = a => `${a.publisher}_${a.name}_${a.version}.app`.replace(/[\\/:*?"<>|]/g, '_')

export { compareVersions, dirname }
