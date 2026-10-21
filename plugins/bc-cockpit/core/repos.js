import { joinPath } from './util.js'

/**
 * Reduces any Azure DevOps remote form to `org/project/repo` (lower case, decoded):
 *   https://org@dev.azure.com/org/project/_git/repo
 *   https://dev.azure.com/org/project/_git/repo
 *   https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
 *   git@ssh.dev.azure.com:v3/org/project/repo
 *   org@vs-ssh.visualstudio.com:v3/org/project/repo
 * Returns null for anything else.
 */
export function normaliseRemote(url) {
  if (!url) return null
  const u = url.trim()
  const dec = s => decodeURIComponent(s).toLowerCase()
  let m = u.match(/^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:v3\/)?([^/]+)\/([^/]+)\/([^/]+?)\/?$/i)
  if (m) return `${dec(m[1])}/${dec(m[2])}/${dec(m[3])}`
  m = u.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i)
  if (m) return `${dec(m[1])}/${dec(m[2])}/${dec(m[3])}`
  m = u.match(/^https?:\/\/([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i)
  if (m) return `${dec(m[1])}/${dec(m[2])}/${dec(m[3])}`
  return null
}

export function remotesFromGitConfig(text) {
  return [...text.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map(m => m[1])
}

/** Scans `repoRoots` one level deep for a clone whose remotes normalise to `org/project/repo`. */
export async function resolveLocalRepo(io, repoRoots, remoteUrl) {
  const wanted = normaliseRemote(remoteUrl)
  if (!wanted) return null
  for (const root of repoRoots ?? []) {
    let entries
    try {
      entries = await io.fs.list(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.kind !== 'dir') continue
      const dir = joinPath(root, entry.name)
      let config
      try {
        config = await io.fs.read(joinPath(dir, '.git', 'config'))
      } catch {
        continue // not a clone (or a worktree/submodule whose .git is a file)
      }
      if (remotesFromGitConfig(config).some(r => normaliseRemote(r) === wanted)) return dir
    }
  }
  return null
}
