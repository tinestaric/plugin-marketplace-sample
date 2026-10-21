// Extension: dev-workflow
// A visual navigator for the spec → design → implement → iterate → review → PR loop.
// Workflows are per feature and linked to git branches (see store.mjs), so any session
// on a linked branch — including sessions spun up from the canvas — shares the same progress.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { DEFAULT_PHASES, MODES } from "./phases.mjs";
import { Store, detectRepo, dirtyCount, slugify } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
// Private data lives outside the extension folder so it survives plugin updates and reinstalls.
const userArtifactsDir = join(copilotHome, "extension-data", "dev-workflow");
// Where the user-scope version of this extension kept phases.json; still honoured if present.
const legacyArtifactsDir = join(copilotHome, "extensions", "dev-workflow", "artifacts");
const MARKER = /\[dev-workflow:([a-z0-9-]+)(?::([a-z0-9_-]+))?\]/i;

let session;
let phases = DEFAULT_PHASES;
let cwd = process.cwd();
let repo = null; // { isGit, top, storeRoot, branch, branchKey }
let store = null;
let current = null; // workflow linked to the current branch, or null
let index = []; // all workflows in this repo
let resolveReady;
const ready = new Promise((r) => (resolveReady = r));
const runtime = { busy: false, mode: null, lastReply: "", lastReplyAt: null, agents: [], dirty: 0 };
const servers = new Map(); // instanceId → { server, url }
const sseClients = new Set();

// ---------- phases ----------

async function loadPhases() {
    const file = [join(userArtifactsDir, "phases.json"), join(legacyArtifactsDir, "phases.json")].find((f) => existsSync(f));
    if (!file) return DEFAULT_PHASES;
    try {
        const custom = JSON.parse(await readFile(file, "utf8"));
        if (!Array.isArray(custom)) return DEFAULT_PHASES;
        const merged = DEFAULT_PHASES.map((d) => ({ ...d, ...(custom.find((c) => c.id === d.id) || {}) }));
        for (const c of custom) {
            if (c?.id && !merged.some((m) => m.id === c.id)) merged.push({ checklist: [], snippets: [], mode: "interactive", icon: "•", goal: "", prompt: "", title: c.id, ...c });
        }
        const result = merged.filter((p) => !p.disabled);
        return result.length ? result : DEFAULT_PHASES;
    } catch (e) {
        await session?.log(`dev-workflow: failed to parse phases.json (${e.message}); using defaults`, { level: "warning" });
        return DEFAULT_PHASES;
    }
}

const phaseDef = (id) => phases.find((p) => p.id === id);
const phaseIndex = (id) => phases.findIndex((p) => p.id === id);

// ---------- workflow model ----------

function freshPhaseState(p, active) {
    return { status: active ? "active" : "todo", checks: {}, notes: "", promptOverride: null, mode: p.mode, startedAt: active ? Date.now() : null, completedAt: null, spawned: [] };
}

function newWorkflow(feature, context) {
    return {
        version: 2,
        id: slugify(feature),
        feature: feature || "",
        context: context || "",
        artifactsDir: null,
        createdAt: Date.now(),
        currentPhase: phases[0].id,
        autoSendOnNext: false,
        phases: Object.fromEntries(phases.map((p, i) => [p.id, freshPhaseState(p, i === 0)])),
        branches: [],
        history: [],
    };
}

function normalize(wf) {
    if (!wf) return wf;
    wf.phases ??= {};
    for (const p of phases) wf.phases[p.id] ??= freshPhaseState(p, false);
    if (!phaseDef(wf.currentPhase)) wf.currentPhase = phases[0].id;
    wf.history ??= [];
    wf.branches ??= [];
    return wf;
}

function paths(wf) {
    const dir = wf.artifactsDir || store.folder(wf.id);
    return { artifactsDir: dir, specPath: join(dir, "spec.md"), designPath: join(dir, "design.md") };
}

function renderPrompt(wf, id) {
    const def = phaseDef(id);
    const ps = wf.phases[id];
    const tpl = ps.promptOverride ?? def.prompt ?? "";
    const vars = {
        feature: wf.feature || "(unnamed feature)",
        context: wf.context ? `\nAdditional context: ${wf.context}\n` : "",
        notes: ps.notes || "",
        ...paths(wf),
    };
    return tpl
        .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m))
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function logHistory(wf, kind, phase, text) {
    wf.history.unshift({ at: Date.now(), kind, phase, branch: repo?.branchKey, text: text.length > 300 ? text.slice(0, 300) + "…" : text });
    wf.history = wf.history.slice(0, 150);
}

function goTo(wf, id, { complete = false } = {}) {
    if (!phaseDef(id)) throw new CanvasError("unknown_phase", `Unknown phase "${id}"`);
    if (id === wf.currentPhase) return;
    const cur = wf.phases[wf.currentPhase];
    const forward = phaseIndex(id) > phaseIndex(wf.currentPhase);
    if (cur) {
        if (complete || forward) {
            cur.status = "done";
            cur.completedAt ??= Date.now();
        } else {
            cur.status = cur.completedAt ? "done" : "todo";
        }
    }
    wf.currentPhase = id;
    const next = wf.phases[id];
    next.status = "active";
    next.startedAt ??= Date.now();
    next.completedAt = null;
    logHistory(wf, "phase", id, `Moved to ${phaseDef(id).title}`);
}

// ---------- context / binding ----------

async function refreshContext() {
    const r = await detectRepo(cwd, join(userArtifactsDir, "no-repo"), session?.sessionId ?? "unknown");
    if (!store || !repo || r.storeRoot !== repo.storeRoot) store = new Store(r.storeRoot);
    repo = r;
    index = (await store.list()).map(normalize);
    current = index.find((w) => w.branches.some((b) => b.name === repo.branchKey)) || null;
    runtime.dirty = repo.isGit ? await dirtyCount(cwd) : 0;
}

function fingerprint() {
    return JSON.stringify([repo?.branchKey, runtime.dirty, current?.id, current?.updatedAt, index.map((w) => [w.id, w.updatedAt])]);
}

function requireCurrent() {
    if (!current) throw new CanvasError("no_workflow", `No workflow is linked to branch "${repo?.branchKey}". Create one or link an existing one first.`);
    return current;
}

async function mutate(fn, id = requireCurrent().id) {
    const { wf, result } = await store.mutate(id, (w) => fn(normalize(w)));
    normalize(wf);
    index = [wf, ...index.filter((w) => w.id !== wf.id)];
    if (wf.branches.some((b) => b.name === repo.branchKey)) current = wf;
    else if (current?.id === wf.id) current = null;
    broadcast();
    return result;
}

async function unlinkFromOthers(exceptId) {
    for (const w of index) {
        if (w.id !== exceptId && w.branches.some((b) => b.name === repo.branchKey)) {
            await mutate((x) => {
                x.branches = x.branches.filter((b) => b.name !== repo.branchKey);
                logHistory(x, "link", x.currentPhase, `Branch ${repo.branchKey} unlinked`);
            }, w.id);
        }
    }
}

async function createWorkflow(feature, context) {
    await unlinkFromOthers(null);
    const wf = newWorkflow(feature, context);
    wf.branches.push({ name: repo.branchKey, role: "main", addedAt: Date.now(), sessionId: session.sessionId });
    logHistory(wf, "phase", wf.currentPhase, `Workflow started on ${repo.branchKey}`);
    await store.write(wf);
    current = wf;
    index = [wf, ...index];
    broadcast();
    return wf;
}

async function linkBranch(id, { role = "linked", phase = null } = {}) {
    if (current?.id === id) return current;
    if (!(await store.read(id))) throw new CanvasError("unknown_workflow", `Workflow "${id}" not found in this repo`);
    await unlinkFromOthers(id);
    await mutate((w) => {
        if (!w.branches.some((b) => b.name === repo.branchKey)) {
            w.branches.push({ name: repo.branchKey, role, phase, addedAt: Date.now(), sessionId: session.sessionId });
            logHistory(w, "link", phase || w.currentPhase, `Branch ${repo.branchKey} linked${role === "spawned" ? ` (spawned for ${phaseDef(phase)?.title ?? phase})` : ""}`);
        }
    }, id);
    return current;
}

async function unlinkBranch() {
    const wf = requireCurrent();
    await mutate((w) => {
        w.branches = w.branches.filter((b) => b.name !== repo.branchKey);
        logHistory(w, "link", w.currentPhase, `Branch ${repo.branchKey} unlinked`);
    }, wf.id);
    current = null;
    broadcast();
}

async function handleMarker(text) {
    const m = typeof text === "string" && text.match(MARKER);
    if (!m) return;
    const [, id, phase] = m;
    if (current?.id === id) return;
    try {
        await linkBranch(id, { role: "spawned", phase: phaseDef(phase) ? phase : null });
    } catch (e) {
        await session.log(`dev-workflow: could not link to workflow ${id}: ${e.message}`, { level: "warning" });
    }
}

// ---------- snapshot / broadcast ----------

function snapshot() {
    const wf = current;
    return {
        repo: repo && { isGit: repo.isGit, branch: repo.branch, branchKey: repo.branchKey, top: repo.top, dirty: runtime.dirty },
        workflows: index.map((w) => ({ id: w.id, feature: w.feature, currentPhase: w.currentPhase, phaseTitle: phaseDef(w.currentPhase)?.title, branches: w.branches.map((b) => b.name), updatedAt: w.updatedAt })),
        state: wf,
        phases: wf ? phases.map((d) => ({ ...d, rendered: renderPrompt(wf, d.id), isOverridden: wf.phases[d.id].promptOverride != null })) : phases,
        modes: MODES,
        runtime,
        artifacts: wf
            ? (({ specPath, designPath }) => ({
                  spec: { path: specPath, exists: existsSync(specPath) },
                  design: { path: designPath, exists: existsSync(designPath) },
              }))(paths(wf))
            : {},
    };
}

function broadcast() {
    if (!repo) return;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of sseClients) res.write(payload);
}

// Picks up changes made by other sessions/worktrees and branch switches in this one.
let polling = false;
setInterval(async () => {
    if (polling || servers.size === 0 || !repo) return;
    polling = true;
    try {
        const before = fingerprint();
        await refreshContext();
        if (fingerprint() !== before) broadcast();
    } catch {
    } finally {
        polling = false;
    }
}, 2500).unref();

// ---------- chat actions ----------

async function setMode(mode) {
    if (!mode || !MODES.includes(mode) || mode === runtime.mode) return;
    try {
        await session.rpc.mode.set({ mode });
        runtime.mode = mode;
    } catch (e) {
        await session.log(`dev-workflow: could not switch mode to ${mode}: ${e.message}`, { level: "warning" });
    }
}

async function sendToChat(prompt, { mode, phase, kind = "send" } = {}) {
    if (!prompt?.trim()) throw new CanvasError("empty_prompt", "Prompt is empty");
    await setMode(mode);
    await session.send({ prompt });
    if (current) await mutate((w) => logHistory(w, kind, phase ?? w.currentPhase, prompt));
}

async function spawnSession({ phase, agent, mode, prompt }) {
    const wf = requireCurrent();
    const def = phaseDef(phase) ?? phaseDef(wf.currentPhase);
    if (!prompt?.trim()) throw new CanvasError("empty_prompt", "Prompt is empty");
    runtime.dirty = repo.isGit ? await dirtyCount(cwd) : 0;
    const name = `${wf.feature || "Feature"} – ${def.title}`.slice(0, 40);
    const kickoffPrompt = `[dev-workflow:${wf.id}:${def.id}] You are a separate session handling the ${def.title.toUpperCase()} phase of the "${wf.feature}" workflow, in your own worktree.\n\n${prompt}`;
    const kickoff = { prompt: kickoffPrompt, mode: MODES.includes(mode) ? mode : "interactive" };
    if (agent) kickoff.agent = agent;
    const base = repo.branch;
    const lines = [
        `[Dev workflow] Spin up a separate session for the ${def.title.toUpperCase()} phase of workflow "${wf.feature}".`,
        "",
        `Call the create_session tool with exactly these arguments (do not perform the task yourself):`,
        `- name: ${JSON.stringify(name)}`,
        `- workspace_type: "worktree"`,
        base ? `- base_branch: ${JSON.stringify(base)}` : null,
        `- notify_on_idle: "once"`,
        `- kickoff: ${JSON.stringify(kickoff, null, 2)}`,
        "",
        runtime.dirty > 0 && base
            ? `IMPORTANT: before creating it, tell me this worktree has ${runtime.dirty} uncommitted change(s) that the new worktree will NOT see (it starts from the last commit of ${base}), and ask whether to commit them first.`
            : null,
        `Then reply with a one-line confirmation linking to the new session.`,
        base
            ? `When it notifies you that it finished: summarize its outcome. If its branch has new commits or uncommitted work, ask me whether to merge it into ${base} or keep it as a separate stacked branch.`
            : `When it notifies you that it finished, summarize its outcome for me.`,
    ].filter((l) => l !== null);
    await session.send({ prompt: lines.join("\n") });
    await mutate((w) => {
        w.phases[def.id].spawned = [...(w.phases[def.id].spawned || []), { at: Date.now(), agent: agent || "default", mode: kickoff.mode, from: repo.branchKey }];
        logHistory(w, "spawn", def.id, `Spawned session "${name}"${agent ? ` with agent ${agent}` : ""} (${kickoff.mode}) from ${base ?? "this session"}`);
    });
}

async function advance({ send } = {}) {
    const wf = requireCurrent();
    const i = phaseIndex(wf.currentPhase);
    if (i >= phases.length - 1) {
        await mutate((w) => {
            const cur = w.phases[w.currentPhase];
            cur.status = "done";
            cur.completedAt = Date.now();
            logHistory(w, "phase", w.currentPhase, "Workflow complete 🎉");
        });
        return { done: true };
    }
    await mutate((w) => {
        const j = phaseIndex(w.currentPhase);
        if (j < phases.length - 1) goTo(w, phases[j + 1].id, { complete: true });
    });
    if (send ?? current.autoSendOnNext) {
        const id = current.currentPhase;
        await sendToChat(renderPrompt(current, id), { mode: current.phases[id].mode, phase: id, kind: "instructions" });
    }
    return { currentPhase: current.currentPhase };
}

async function refreshAgents() {
    try {
        const { agents } = await session.rpc.agent.list();
        runtime.agents = agents
            .filter((a) => a.userInvocable !== false)
            .map((a) => ({ id: a.id, name: a.displayName || a.name, description: a.description }));
    } catch {
        runtime.agents = [];
    }
}

// ---------- HTTP ----------

async function readBody(req) {
    let data = "";
    for await (const chunk of req) {
        data += chunk;
        if (data.length > 1_000_000) throw new Error("Body too large");
    }
    return data ? JSON.parse(data) : {};
}

function requirePhase(w, id) {
    if (!w.phases[id]) throw new Error(`Unknown phase "${id}"`);
    return w.phases[id];
}

const api = {
    "/api/create": (b) => createWorkflow(String(b.feature || "").trim(), b.context),
    "/api/link": (b) => linkBranch(b.id),
    "/api/unlink": () => unlinkBranch(),
    "/api/send": (b) => sendToChat(b.prompt, { mode: b.mode, phase: b.phase, kind: b.kind || "send" }),
    "/api/spawn": (b) => spawnSession(b),
    "/api/advance": (b) => advance({ send: b.send }),
    "/api/back": () =>
        mutate((w) => {
            const i = phaseIndex(w.currentPhase);
            if (i > 0) goTo(w, phases[i - 1].id);
        }),
    "/api/goto": (b) => mutate((w) => goTo(w, b.phase)),
    "/api/check": (b) => mutate((w) => (requirePhase(w, b.phase).checks[b.index] = !!b.value)),
    "/api/phase-update": (b) =>
        mutate((w) => {
            const ps = requirePhase(w, b.phase);
            if ("notes" in b) ps.notes = String(b.notes);
            if ("mode" in b) ps.mode = b.mode;
            if ("promptOverride" in b) ps.promptOverride = b.promptOverride;
        }),
    "/api/settings": (b) =>
        mutate((w) => {
            for (const k of ["feature", "context"]) if (k in b) w[k] = String(b[k]);
            if ("artifactsDir" in b) w.artifactsDir = String(b.artifactsDir).trim() || null;
            if ("autoSendOnNext" in b) w.autoSendOnNext = !!b.autoSendOnNext;
        }),
    "/api/refresh-agents": async () => {
        await refreshAgents();
        broadcast();
    },
    "/api/reset": () =>
        mutate((w) => {
            w.phases = Object.fromEntries(phases.map((p, i) => [p.id, freshPhaseState(p, i === 0)]));
            w.currentPhase = phases[0].id;
            logHistory(w, "phase", w.currentPhase, "Progress reset");
        }),
};

async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
        await ready;
        if (req.method === "GET" && url.pathname === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(await readFile(join(here, "ui.html"), "utf8"));
            return;
        }
        if (req.method === "GET" && url.pathname === "/state") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(snapshot()));
            return;
        }
        if (req.method === "GET" && url.pathname === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
            sseClients.add(res);
            req.on("close", () => sseClients.delete(res));
            return;
        }
        if (req.method === "POST" && api[url.pathname]) {
            const result = await api[url.pathname](await readBody(req));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, result: result && typeof result === "object" && "phases" in result ? { id: result.id } : (result ?? null) }));
            return;
        }
        res.statusCode = 404;
        res.end("Not found");
    } catch (e) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
}

async function startServer() {
    const server = createServer((req, res) => void handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

// ---------- canvas ----------

const phaseIdSchema = { type: "string", description: "Phase id: spec, design, implement, iterate, review, pr (or a custom id)" };

function summary(wf) {
    const { specPath, designPath } = paths(wf);
    return {
        workflowId: wf.id,
        feature: wf.feature,
        branch: repo.branchKey,
        linkedBranches: wf.branches,
        currentPhase: wf.currentPhase,
        artifacts: { spec: { path: specPath, exists: existsSync(specPath) }, design: { path: designPath, exists: existsSync(designPath) } },
        phases: phases.map((p) => ({
            id: p.id,
            title: p.title,
            status: wf.phases[p.id].status,
            checklist: (p.checklist || []).map((c, i) => ({ index: i, item: c, done: !!wf.phases[p.id].checks[i] })),
        })),
    };
}

const canvas = createCanvas({
    id: "dev-workflow",
    displayName: "Dev workflow",
    description: "Visual navigator for the spec → tech design → implement → iterate → code review → PR workflow; sends phase instructions to chat or spins up separate sessions.",
    inputSchema: {
        type: "object",
        properties: {
            workflowId: { type: "string", description: "Link the current branch to this existing workflow" },
            feature: { type: "string", description: "Start a new workflow for this feature if the current branch has none" },
            phase: phaseIdSchema,
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "get_state",
            description: "Return the workflow linked to the current branch: feature, current phase, checklist progress, artifact paths, linked branches.",
            handler: async () => {
                await ready;
                await refreshContext();
                return current ? summary(current) : { workflowId: null, branch: repo.branchKey, message: "No workflow linked to this branch" };
            },
        },
        {
            name: "list_workflows",
            description: "List all dev workflows in this repository with their current phase and linked branches.",
            handler: async () => {
                await ready;
                await refreshContext();
                return snapshot().workflows;
            },
        },
        {
            name: "create_workflow",
            description: "Start a new workflow for a feature and link it to the current branch.",
            inputSchema: { type: "object", properties: { feature: { type: "string" }, context: { type: "string" } }, required: ["feature"], additionalProperties: false },
            handler: async ({ input }) => {
                await ready;
                return summary(await createWorkflow(input.feature, input.context));
            },
        },
        {
            name: "link_workflow",
            description: "Link the current branch to an existing workflow (unlinking it from any other).",
            inputSchema: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"], additionalProperties: false },
            handler: async ({ input }) => {
                await ready;
                return summary(await linkBranch(input.workflowId));
            },
        },
        {
            name: "set_feature",
            description: "Rename the current workflow's feature and/or set extra context used in phase prompts.",
            inputSchema: { type: "object", properties: { feature: { type: "string" }, context: { type: "string" } }, additionalProperties: false },
            handler: async ({ input }) => {
                await ready;
                await mutate((w) => {
                    if (input.feature != null) w.feature = input.feature;
                    if (input.context != null) w.context = input.context;
                });
                return { ok: true };
            },
        },
        {
            name: "check_item",
            description: "Mark a phase checklist item as done/undone after verifying that exit criterion.",
            inputSchema: {
                type: "object",
                properties: { phase: phaseIdSchema, index: { type: "integer", minimum: 0 }, done: { type: "boolean" } },
                required: ["phase", "index"],
                additionalProperties: false,
            },
            handler: async ({ input }) => {
                await ready;
                await mutate((w) => {
                    if (!w.phases[input.phase]) throw new CanvasError("unknown_phase", `Unknown phase "${input.phase}"`);
                    w.phases[input.phase].checks[input.index] = input.done ?? true;
                });
                return { ok: true };
            },
        },
        {
            name: "go_to_phase",
            description: "Jump the workflow to a specific phase (does not send instructions).",
            inputSchema: { type: "object", properties: { phase: phaseIdSchema }, required: ["phase"], additionalProperties: false },
            handler: async ({ input }) => {
                await ready;
                await mutate((w) => goTo(w, input.phase));
                return { currentPhase: current.currentPhase };
            },
        },
        {
            name: "next_phase",
            description: "Complete the current phase and move to the next one. Does not send instructions to chat.",
            handler: async () => {
                await ready;
                return advance({ send: false });
            },
        },
    ],
    open: async (ctx) => {
        await ready;
        await refreshContext();
        const input = ctx.input || {};
        if (input.workflowId) await linkBranch(input.workflowId);
        else if (input.feature && !current) await createWorkflow(input.feature);
        if (input.phase && current && phaseDef(input.phase)) await mutate((w) => goTo(w, input.phase));
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer();
            servers.set(ctx.instanceId, entry);
        }
        void refreshAgents().then(broadcast);
        return {
            title: "Dev workflow",
            url: entry.url,
            status: current ? `${current.feature || "Feature"} · ${phaseDef(current.currentPhase).title}` : "No workflow on this branch",
        };
    },
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
            servers.delete(ctx.instanceId);
            await new Promise((resolve) => entry.server.close(() => resolve()));
        }
    },
});

function phaseContext() {
    if (!current) return undefined;
    const def = phaseDef(current.currentPhase);
    const p = paths(current);
    const me = current.branches.find((b) => b.name === repo.branchKey);
    const spawned = me?.role === "spawned" ? ` This session was spun up for the ${phaseDef(me.phase)?.title ?? "current"} phase; stay focused on it.` : "";
    return `[Dev workflow] Feature: "${current.feature}" (workflow ${current.id}, branch ${repo.branchKey}). Current phase: ${def.title} — ${def.goal} Spec: ${p.specPath}. Design: ${p.designPath}.${spawned} Stay within this phase's scope unless asked otherwise.`;
}

async function hookContext(input, text) {
    // Hooks may fire before startup finishes; never block the turn on it for long.
    await Promise.race([ready, new Promise((r) => setTimeout(r, 5000))]);
    if (!store) return undefined;
    try {
        if (input?.workingDirectory) cwd = input.workingDirectory;
        await refreshContext();
        await handleMarker(text);
        const additionalContext = phaseContext();
        return additionalContext ? { additionalContext } : undefined;
    } catch {
        return undefined;
    }
}

session = await joinSession({
    canvases: [canvas],
    hooks: {
        onSessionStart: (input) => hookContext(input, input?.initialPrompt),
        onUserPromptSubmitted: (input) => hookContext(input, input?.prompt),
    },
});

try {
    const { workspace } = await session.rpc.workspaces.getWorkspace();
    if (workspace?.cwd) cwd = workspace.cwd;
} catch {}
phases = await loadPhases();
await refreshContext().catch(async (e) => {
    await session.log(`dev-workflow: failed to load workflows: ${e.message}`, { level: "warning" });
    repo ??= { isGit: false, top: cwd, storeRoot: join(userArtifactsDir, "no-repo"), branch: null, branchKey: `session@${session.sessionId}` };
    store ??= new Store(repo.storeRoot);
});
try {
    const m = await session.rpc.mode.get();
    runtime.mode = typeof m === "string" ? m : (m?.mode ?? null);
} catch {}
resolveReady();

session.on("assistant.turn_start", () => {
    runtime.busy = true;
    broadcast();
});
session.on("session.idle", () => {
    runtime.busy = false;
    broadcast();
});
session.on("assistant.message", (e) => {
    const content = e?.data?.content;
    if (typeof content === "string" && content.trim() && !e.agentId) {
        runtime.lastReply = content.length > 2000 ? content.slice(0, 2000) + "…" : content;
        runtime.lastReplyAt = Date.now();
        broadcast();
    }
});
session.on("session.mode_changed", (e) => {
    runtime.mode = e?.data?.newMode ?? runtime.mode;
    broadcast();
});
