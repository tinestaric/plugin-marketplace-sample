// Workflow storage. One workflow per feature, stored inside the repo's shared git dir
// (<git-common-dir>/dev-workflow/workflows/<id>/workflow.json) so every worktree and every
// session of the same repo sees it, and nothing is committed. Branches are linked to a
// workflow; a session shows the workflow its current branch is linked to.

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";

function git(cwd, args) {
    return new Promise((res, rej) =>
        execFile("git", args, { cwd, windowsHide: true, timeout: 10000 }, (err, stdout) => (err ? rej(err) : res(stdout.trim()))),
    );
}

export async function detectRepo(cwd, fallbackRoot, sessionId) {
    try {
        let common = await git(cwd, ["rev-parse", "--git-common-dir"]);
        if (!isAbsolute(common)) common = resolve(cwd, common);
        const branch = await git(cwd, ["branch", "--show-current"]).catch(() => "");
        const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd);
        return { isGit: true, cwd, top, storeRoot: join(common, "dev-workflow"), branch: branch || null, branchKey: branch || `detached@${sessionId}` };
    } catch {
        return { isGit: false, cwd, top: cwd, storeRoot: fallbackRoot, branch: null, branchKey: `session@${sessionId}` };
    }
}

export async function dirtyCount(cwd) {
    try {
        const out = await git(cwd, ["status", "--porcelain"]);
        return out ? out.split("\n").length : 0;
    } catch {
        return 0;
    }
}

export class Store {
    constructor(root) {
        this.root = root;
        this.dir = join(root, "workflows");
        this.lock = Promise.resolve();
    }
    file(id) {
        return join(this.dir, id, "workflow.json");
    }
    folder(id) {
        return join(this.dir, id);
    }
    async read(id) {
        try {
            return JSON.parse(await readFile(this.file(id), "utf8"));
        } catch {
            return null;
        }
    }
    async mtime(id) {
        try {
            return (await stat(this.file(id))).mtimeMs;
        } catch {
            return 0;
        }
    }
    async write(wf) {
        wf.updatedAt = Date.now();
        await mkdir(this.folder(wf.id), { recursive: true });
        const tmp = this.file(wf.id) + `.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(wf, null, 2));
        await rename(tmp, this.file(wf.id));
    }
    async list() {
        let ids = [];
        try {
            ids = (await readdir(this.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
            return [];
        }
        const all = await Promise.all(ids.map((id) => this.read(id)));
        return all.filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    async findByBranch(key) {
        return (await this.list()).find((w) => (w.branches || []).some((b) => b.name === key)) || null;
    }
    /** Serialized read-modify-write so concurrent sessions don't clobber each other's changes. */
    mutate(id, fn) {
        const run = this.lock.then(async () => {
            const wf = await this.read(id);
            if (!wf) throw new Error(`Workflow "${id}" not found`);
            const result = await fn(wf);
            await this.write(wf);
            return { wf, result };
        });
        this.lock = run.catch(() => {});
        return run;
    }
}

export function slugify(s) {
    const base = String(s || "feature")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "feature";
    return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}
