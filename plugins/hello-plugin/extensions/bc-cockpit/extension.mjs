// BC Cockpit — Copilot canvas adapter. All data logic lives in ./core (host-neutral).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createCockpit, buildFixPrompt, buildConflictPrompt } from "./core/index.mjs";
import { startUiServer, HttpError } from "./server.mjs";
import { openInBrowser, validateAzdoUrl } from "./open.mjs";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "ui");
const cockpit = createCockpit();
const instances = new Map(); // instanceId → { server }
let session;
let timer = null;
let lastError = null;

const log = (msg, level = "info") => session?.log(`bc-cockpit: ${msg}`, { level, ephemeral: level === "info" }).catch(() => {});
const broadcast = (event, data) => {
    for (const { server } of instances.values()) server.broadcast(event, data);
};

async function refresh({ force = false } = {}) {
    broadcast("status", { refreshing: true });
    try {
        const board = await cockpit.getBoard({ force });
        lastError = null;
        broadcast("board", board);
        return board;
    } catch (e) {
        lastError = e.message;
        broadcast("problem", { message: e.message, file: e.file });
        throw e;
    } finally {
        broadcast("status", { refreshing: cockpit.isRefreshing() });
        schedule();
    }
}

function schedule() {
    clearTimeout(timer);
    if (!instances.size) return;
    cockpit
        .getCachedBoard()
        .then((b) => {
            timer = setTimeout(() => refresh({ force: true }).catch(() => {}), (b?.config?.refreshMinutes ?? 3) * 60e3);
            timer.unref?.();
        })
        .catch(() => {});
}

const ORG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRef(src, fields) {
    const get = (k) => (typeof src?.get === "function" ? src.get(k) : src?.[k]);
    const out = {};
    for (const f of fields) {
        const v = get(f);
        if (f === "org" && !(typeof v === "string" && ORG.test(v))) throw new HttpError(400, "org is required");
        if (f === "project" && !(typeof v === "string" && v.trim() && v.length <= 128)) throw new HttpError(400, "project is required");
        if (f === "repoId" && !(typeof v === "string" && GUID.test(v))) throw new HttpError(400, "repoId must be a repository GUID");
        if ((f === "buildId" || f === "prId") && !(Number.isInteger(Number(v)) && Number(v) > 0)) throw new HttpError(400, `${f} must be a positive integer`);
        out[f] = f === "buildId" || f === "prId" ? Number(v) : v;
    }
    return out;
}

/**
 * Hand a prepared task to a NEW agent session. Extensions cannot create sessions themselves, so this asks the
 * current agent to call its session-creation tool with a fully prepared prompt and workspace.
 */
async function startAgentSession({ title, workspace, prompt }) {
    if (!session) throw new HttpError(503, "Session not ready");
    const message = [
        `[BC Cockpit] Start a new agent session for this task. Do not do the work in this session.`,
        "",
        "Call create_session with exactly:",
        `- title: ${JSON.stringify(title)}`,
        `- workspace: ${JSON.stringify(workspace)}`,
        "- worktree: true",
        "- prompt: the text between the markers below, verbatim",
        "",
        "If you have no tool that creates sessions, tell me and ask whether to do it here instead.",
        "Then reply with one line linking to the new session.",
        "",
        "<<<PROMPT",
        prompt,
        "PROMPT>>>",
    ].join("\n");
    await session.send({ prompt: message });
}

const routes = {
    "GET /api/board": async () => ({ board: await cockpit.getCachedBoard(), refreshing: cockpit.isRefreshing(), problem: lastError }),
    "POST /api/refresh": async () => {
        refresh({ force: true }).catch(() => {});
        return { ok: true };
    },
    "POST /api/open": async ({ body }) => {
        const url = validateAzdoUrl(body?.url);
        if (!url) throw new HttpError(400, "Only https Azure DevOps links can be opened");
        await openInBrowser(url);
        return { ok: true };
    },
    "POST /api/session/failure": async ({ body }) => {
        const f = await cockpit.getFailureDetails(readRef(body, ["org", "project", "buildId"]));
        if (!f.localPath) throw new HttpError(409, `No local clone found for ${f.remoteUrl ?? f.repo}. Add its parent folder to repoRoots.`);
        await startAgentSession({ title: `Investigate pipeline failure: ${f.repo}${f.prId ? ` PR !${f.prId}` : ""}`.slice(0, 80), workspace: f.localPath, prompt: buildFixPrompt(f) });
        return { ok: true };
    },
    "POST /api/session/conflict": async ({ body }) => {
        const c = await cockpit.getConflictDetails(readRef(body, ["org", "project", "repoId", "prId"]));
        if (!c.localPath) throw new HttpError(409, `No local clone found for ${c.remoteUrl ?? c.repo}. Add its parent folder to repoRoots.`);
        await startAgentSession({ title: `Resolve merge conflicts: ${c.repo} PR !${c.prId}`.slice(0, 80), workspace: c.localPath, prompt: buildConflictPrompt(c) });
        return { ok: true };
    },
};

/** Compact JSON for the agent: same data as the UI, without presentation-only fields. */
function compactBoard(b) {
    if (!b) return null;
    return {
        fetchedAt: b.fetchedAt,
        auth: b.auth,
        organisations: b.config?.organisations,
        sprintOnly: b.config?.sprintOnly,
        errors: b.errors.map((e) => `${e.org}${e.project ? `/${e.project}` : ""} ${e.area}: ${e.message}`),
        workItems: b.workItems.map((w) => ({ org: w.org, project: w.project, sprint: w.sprint?.name ?? null, id: w.id, type: w.type, state: w.state, priority: w.priority, title: w.title, url: w.url })),
        pullRequests: b.pullRequests.map((p) => ({
            org: p.org, project: p.project, repo: p.repo, repoId: p.repoId, id: p.id, title: p.title, source: p.sourceBranch, target: p.targetBranch,
            roles: p.roles, draft: p.isDraft, myVote: p.myVote, votes: p.voteState, hasConflicts: p.hasConflicts,
            pipeline: p.build ? { buildId: p.build.id, definition: p.build.definition, state: p.build.state } : null, hasLocalClone: !!p.localPath, url: p.url,
        })),
    };
}

const asCanvasError = (e) => new CanvasError(e instanceof HttpError || e instanceof TypeError ? "invalid_input" : "unavailable", e.message);

const canvas = createCanvas({
    id: "bc-cockpit",
    displayName: "BC Cockpit",
    description: "Current-sprint work items and pull requests (with merge conflict and pipeline status) across Azure DevOps organisations, with one-click agent sessions to fix PRs.",
    actions: [
        {
            name: "cockpit_get_board",
            description: "Return my current-sprint work items and my active PRs (merge conflicts, latest pipeline state) as compact JSON. Read-only.",
            handler: async () => compactBoard((await cockpit.getCachedBoard()) ?? (await refresh())),
        },
        {
            name: "cockpit_get_failure",
            description: "Deterministically prepare a failed pipeline run: failing steps, trimmed AL errors/test failures, branch, commit and local clone path. Read-only.",
            inputSchema: {
                type: "object",
                properties: {
                    buildId: { type: "integer", minimum: 1, description: "Azure DevOps build ID (pullRequests[].pipeline.buildId)" },
                    org: { type: "string", description: "Azure DevOps organisation name" },
                    project: { type: "string", description: "Project name" },
                },
                required: ["buildId", "org", "project"],
                additionalProperties: false,
            },
            handler: async ({ input }) => {
                try {
                    return await cockpit.getFailureDetails(readRef(input, ["org", "project", "buildId"]));
                } catch (e) {
                    throw asCanvasError(e);
                }
            },
        },
        {
            name: "cockpit_get_conflicts",
            description: "Deterministically prepare a PR's merge conflicts: source/target branches, conflicting files and local clone path. Read-only.",
            inputSchema: {
                type: "object",
                properties: {
                    org: { type: "string" },
                    project: { type: "string" },
                    repoId: { type: "string", description: "Repository GUID (pullRequests[].repoId)" },
                    prId: { type: "integer", minimum: 1 },
                },
                required: ["org", "project", "repoId", "prId"],
                additionalProperties: false,
            },
            handler: async ({ input }) => {
                try {
                    return await cockpit.getConflictDetails(readRef(input, ["org", "project", "repoId", "prId"]));
                } catch (e) {
                    throw asCanvasError(e);
                }
            },
        },
        {
            name: "cockpit_refresh",
            description: "Force a refresh of the cockpit from Azure DevOps and return a summary. Read-only against Azure DevOps.",
            handler: async () => {
                const b = await refresh({ force: true }).catch((e) => {
                    throw new CanvasError("refresh_failed", e.message);
                });
                return {
                    fetchedAt: b.fetchedAt,
                    auth: b.auth,
                    workItems: b.workItems.length,
                    pullRequests: b.pullRequests.length,
                    withConflicts: b.pullRequests.filter((p) => p.hasConflicts).length,
                    failingPipelines: b.pullRequests.filter((p) => p.build?.state === "failed").length,
                    errors: b.errors.length,
                };
            },
        },
    ],
    async open({ instanceId }) {
        let inst = instances.get(instanceId);
        if (!inst) {
            let server;
            try {
                server = await startUiServer({
                    uiDir,
                    routes,
                    sse: async () => [["board", await cockpit.getCachedBoard()], ["status", { refreshing: cockpit.isRefreshing() }]],
                    log: (m) => log(m, "warning"),
                });
            } catch (e) {
                throw new CanvasError("server_failed", `Could not start the cockpit UI server: ${e.message}`);
            }
            inst = { server };
            instances.set(instanceId, inst);
        }
        try {
            await cockpit.loadConfig();
        } catch (e) {
            throw new CanvasError(e.code ?? "config_invalid", e.message);
        }
        refresh().catch((e) => log(`refresh failed: ${e.message}`, "warning"));
        return { url: inst.server.url, title: "BC Cockpit" };
    },
    async onClose({ instanceId }) {
        const inst = instances.get(instanceId);
        instances.delete(instanceId);
        await inst?.server.close();
        if (!instances.size) clearTimeout(timer);
    },
});

/** `/bc-cockpit` opens (or focuses) the canvas directly, without an agent turn. */
const openCommand = {
    name: "bc-cockpit",
    description: "Open BC Cockpit: current-sprint work items and pull requests across Azure DevOps",
    handler: async () => {
        try {
            await session.rpc.canvas.open({ canvasId: "bc-cockpit", instanceId: "bc-cockpit" });
        } catch (e) {
            log(`could not open the canvas: ${e.message}`, "warning");
        }
    },
};

session = await joinSession({ canvases: [canvas], commands: [openCommand], requestedEnvironmentVariables: ["AZDO_PAT"] });
