import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Normalise a git remote URL to a comparable key.
 * All Azure DevOps forms (https dev.azure.com, user@dev.azure.com, *.visualstudio.com with or
 * without DefaultCollection, ssh v3) collapse to `azdo:org/project/repo`; GitHub to `github:owner/repo`.
 */
export function normaliseRemote(url) {
    if (!url || typeof url !== "string") return null;
    let u = url.trim();
    try {
        u = decodeURIComponent(u);
    } catch {
        /* keep raw */
    }
    u = u.replace(/\.git$/i, "").replace(/\/+$/, "");
    let m;
    if ((m = u.match(/^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+)$/i))) {
        return `azdo:${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
    }
    if ((m = u.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i))) {
        return `azdo:${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
    }
    if ((m = u.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i))) {
        return `azdo:${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
    }
    if ((m = u.match(/^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/?#]+)/i))) {
        return `github:${m[1]}/${m[2]}`.toLowerCase();
    }
    return u.toLowerCase();
}

/** Extract remote URLs from the text of a .git/config file. */
export function parseGitConfigRemotes(text) {
    const urls = [];
    let inRemote = false;
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith("[")) inRemote = /^\[remote\s+"/i.test(t);
        else if (inRemote) {
            const m = t.match(/^url\s*=\s*(.+)$/i);
            if (m) urls.push(m[1].trim());
        }
    }
    return urls;
}

async function gitConfigFor(dir) {
    const dotGit = join(dir, ".git");
    let s;
    try {
        s = await stat(dotGit);
    } catch {
        return null;
    }
    if (s.isDirectory()) return join(dotGit, "config");
    // Worktree or submodule: ".git" is a file pointing at the real git dir.
    const m = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitDir = resolve(dir, m[1].trim());
    const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => null);
    return join(common ? resolve(gitDir, common.trim()) : gitDir, "config");
}

/** Scan each root and its direct children for git clones. Returns Map<normalisedRemote, path>. */
export async function scanRepoRoots(roots) {
    const map = new Map();
    const add = async (dir) => {
        const cfg = await gitConfigFor(dir);
        if (!cfg) return;
        const text = await readFile(cfg, "utf8").catch(() => "");
        for (const url of parseGitConfigRemotes(text)) {
            const key = normaliseRemote(url);
            if (key && !map.has(key)) map.set(key, dir);
        }
    };
    for (const root of roots) {
        const r = resolve(root);
        await add(r);
        const entries = await readdir(r, { withFileTypes: true }).catch(() => []);
        await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => add(join(r, e.name))));
    }
    return map;
}

/** Cached resolver so a board refresh does not rescan disks for every pipeline. */
export function createRepoResolver({ getRoots, ttlMs = 60000, now = () => Date.now(), scan = scanRepoRoots }) {
    let cache = null;
    async function index() {
        if (!cache || now() - cache.at > ttlMs) cache = { at: now(), map: scan(await getRoots()) };
        return cache.map;
    }
    return {
        async resolve(remoteUrl) {
            const key = normaliseRemote(remoteUrl);
            if (!key) return null;
            return (await index()).get(key) ?? null;
        },
        clear() {
            cache = null;
        },
    };
}
