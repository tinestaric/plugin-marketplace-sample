import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseJsonc } from "./util.mjs";

const SKIP_DIRS = new Set([".alpackages", "node_modules", ".git", ".output", ".snapshots", ".vs", ".github", ".altestrunner", ".artifacts"]);
const MAX_DEPTH = 6;

async function findAppJsons(root, depth = 0, out = []) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return out;
    }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === "app.json")) out.push(join(root, "app.json"));
    if (depth >= MAX_DEPTH) return out;
    for (const e of entries) {
        if (e.isDirectory() && !SKIP_DIRS.has(e.name.toLowerCase())) await findAppJsons(join(root, e.name), depth + 1, out);
    }
    return out;
}

/** Folders to search: the .code-workspace folder list when one exists at the root, else the root itself. */
export async function workspaceFolders(workspaceRoot) {
    const root = resolve(workspaceRoot);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const ws = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(".code-workspace"));
    if (ws) {
        try {
            const def = parseJsonc(await readFile(join(root, ws.name), "utf8"));
            const folders = (def.folders ?? []).map((f) => resolve(root, f.path ?? ".")).filter(Boolean);
            if (folders.length) return { folders, workspaceFile: join(root, ws.name), name: basename(ws.name, ".code-workspace") };
        } catch {
            /* fall back to plain folder scan */
        }
    }
    return { folders: [root], workspaceFile: null, name: basename(root) };
}

export function parseAppJson(text, path) {
    const j = parseJsonc(text);
    if (!j || typeof j.id !== "string" || typeof j.name !== "string") throw new Error(`${path}: not an AL app.json (missing id/name)`);
    return {
        id: j.id.toLowerCase(),
        name: j.name,
        publisher: j.publisher ?? "",
        version: j.version ?? "1.0.0.0",
        dependencies: (j.dependencies ?? []).map((d) => ({ id: String(d.id ?? d.appId ?? "").toLowerCase(), name: d.name, publisher: d.publisher, version: d.version })),
        idRanges: j.idRanges ?? (j.idRange ? [j.idRange] : []),
        runtime: j.runtime ?? null,
        application: j.application ?? null,
        platform: j.platform ?? null,
    };
}

/** Kahn topological sort: dependencies first, ties broken by name. Cycles are appended and flagged. */
export function orderByDependencies(apps) {
    const byId = new Map(apps.map((a) => [a.id, a]));
    const indeg = new Map(apps.map((a) => [a.id, 0]));
    const dependents = new Map(apps.map((a) => [a.id, []]));
    for (const a of apps) {
        for (const d of a.dependencies) {
            if (byId.has(d.id) && d.id !== a.id) {
                indeg.set(a.id, indeg.get(a.id) + 1);
                dependents.get(d.id).push(a.id);
            }
        }
    }
    const ready = apps.filter((a) => indeg.get(a.id) === 0).map((a) => a.id);
    const sortReady = () => ready.sort((x, y) => byId.get(x).name.localeCompare(byId.get(y).name));
    sortReady();
    const out = [];
    while (ready.length) {
        const id = ready.shift();
        out.push(byId.get(id));
        for (const dep of dependents.get(id)) {
            indeg.set(dep, indeg.get(dep) - 1);
            if (indeg.get(dep) === 0) {
                ready.push(dep);
                sortReady();
            }
        }
    }
    const cyclic = apps.filter((a) => !out.includes(a));
    return [...out, ...cyclic.map((a) => ({ ...a, cycle: true }))];
}

/** Every AL app under the workspace, ordered so base apps come first. */
export async function discoverApps(workspaceRoot) {
    const { folders } = await workspaceFolders(workspaceRoot);
    const files = [...new Set((await Promise.all(folders.map((f) => findAppJsons(f)))).flat())];
    const apps = [];
    const errors = [];
    for (const file of files) {
        try {
            apps.push({ ...parseAppJson(await readFile(file, "utf8"), file), path: dirname(file) });
        } catch (e) {
            errors.push({ path: file, message: e.message });
        }
    }
    const seen = new Set();
    const unique = apps.filter((a) => (seen.has(a.path.toLowerCase()) ? false : seen.add(a.path.toLowerCase())));
    const ids = new Map(unique.map((a) => [a.id, a]));
    const ordered = orderByDependencies(unique).map((a, i) => ({
        ...a,
        order: i,
        dependsOn: a.dependencies.filter((d) => ids.has(d.id)).map((d) => ids.get(d.id).name),
        dependencies: a.dependencies.map((d) => ({ ...d, inWorkspace: ids.has(d.id) })),
    }));
    return Object.assign(ordered, { errors });
}
