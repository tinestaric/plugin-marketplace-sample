// BC Publisher — Copilot canvas adapter. Compile/publish logic lives in ./core (host-neutral).
import { dirname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createPublisher, buildErrorPrompt, canPublish } from "./core/index.mjs";
import { createJobRunner } from "./jobs.mjs";
import { startUiServer, HttpError } from "./server.mjs";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "ui");
const contexts = new Map(); // workspace root → { publisher, jobs, servers, snapshot, refreshing }
const instances = new Map(); // instanceId → { server, ctx }
let session;

const log = (msg, level = "info") => session?.log(`bc-publisher: ${msg}`, { level, ephemeral: level === "info" }).catch(() => {});

/** Nearest ancestor containing .git (directory or worktree file), else the folder itself. */
function repoRootOf(dir) {
    for (let d = dir; ; ) {
        if (existsSync(join(d, ".git"))) return d;
        const up = dirname(d);
        if (up === d) return dir;
        d = up;
    }
}

function contextFor(root) {
    const key = resolve(root).toLowerCase();
    if (contexts.has(key)) return contexts.get(key);
    const ctx = { root: resolve(root), servers: new Set(), snapshot: null, refreshing: null };
    ctx.publisher = createPublisher({ workspaceRoot: ctx.root });
    ctx.emit = (event, data) => {
        for (const s of ctx.servers) s.broadcast(event, data);
        if (event === "job" && ["done", "failed", "cancelled"].includes(data.state)) refresh(ctx, { environments: data.kind !== "compile" }).catch(() => {});
    };
    ctx.jobs = createJobRunner({ publisher: ctx.publisher, emit: ctx.emit });
    contexts.set(key, ctx);
    return ctx;
}

const compactRun = (r) => r && { id: r.id, kind: r.kind, ok: r.ok, appName: r.appName, appVersion: r.appVersion, environmentId: r.environmentId, actor: r.actor, startedAt: r.startedAt, durationMs: r.durationMs, phase: r.phase, error: r.error };

/** Gather apps, environments, compiler and last runs. Discovery is slow, so callers share one in-flight refresh. */
function refresh(ctx, { force = false, environments = true } = {}) {
    if (ctx.refreshing) return ctx.refreshing;
    ctx.emit("status", { refreshing: true });
    ctx.refreshing = (async () => {
        const p = ctx.publisher;
        const prev = ctx.snapshot;
        const errors = [];
        let config = null;
        try {
            config = await p.loadConfig();
        } catch (e) {
            errors.push({ source: "config", message: e.message });
        }
        const [ws, apps, compiler] = await Promise.all([
            p.workspaceInfo(),
            p.discoverApps().catch((e) => (errors.push({ source: "apps", message: e.message }), [])),
            p.getCompiler({ force }).then((c) => ({ version: c.version, path: c.path })).catch((e) => ({ error: e.message })),
        ]);
        errors.push(...(apps.errors ?? []).map((e) => ({ source: "app.json", message: `${e.path}: ${e.message}` })));
        let envs = prev?.envState;
        if (environments || !envs) {
            envs = config ? await p.discoverEnvironments({ force: true }).catch((e) => ({ environments: [], errors: [{ source: "environments", message: e.message }] })) : { environments: [], errors: [] };
        }
        const runs = await p.listRuns().catch((e) => (errors.push({ source: "runs", message: e.message }), []));
        const lastRuns = {};
        for (const r of runs) if (r.kind === "publish" && r.environmentId && !lastRuns[r.environmentId]) lastRuns[r.environmentId] = compactRun(r);
        // Last compile outcome per app, from compile runs and the compile step of publish runs.
        const lastCompiles = {};
        for (const r of runs) {
            if (r.cancelled || !r.appPath || lastCompiles[r.appPath.toLowerCase()]) continue;
            const ok = r.kind === "compile" ? r.ok : !(r.phase === "compiling" && !r.ok);
            lastCompiles[r.appPath.toLowerCase()] = { ok, at: r.startedAt, actor: r.actor, errors: (r.diagnostics ?? []).filter((d) => d.severity === "error").length };
        }
        ctx.snapshot = {
            workspace: ws,
            compiler,
            configFile: config?.file ?? null,
            apps: apps.map((a) => ({ id: a.id, name: a.name, publisher: a.publisher, version: a.version, path: a.path, order: a.order, dependsOn: a.dependsOn, runtime: a.runtime, application: a.application, cycle: !!a.cycle })),
            environments: envs.environments,
            envState: envs,
            errors: [...errors, ...(envs.errors ?? [])],
            lastRuns,
            lastCompiles,
            fetchedAt: new Date().toISOString(),
        };
        ctx.emit("state", publicState(ctx));
        return ctx.snapshot;
    })().finally(() => {
        ctx.refreshing = null;
        ctx.emit("status", { refreshing: false });
    });
    return ctx.refreshing;
}

function publicState(ctx) {
    if (!ctx.snapshot) return null;
    const { envState, ...rest } = ctx.snapshot;
    return { ...rest, jobs: ctx.jobs.list() };
}

async function stateOf(ctx) {
    return ctx.snapshot ?? (await refresh(ctx));
}

function appByPath(ctx, appPath) {
    const app = ctx.snapshot?.apps.find((a) => a.path.toLowerCase() === resolve(ctx.root, String(appPath ?? "")).toLowerCase());
    if (!app) throw new HttpError(400, `"${appPath}" is not an AL app in this workspace.`);
    return app;
}

function envById(ctx, id) {
    const env = ctx.snapshot?.environments.find((e) => e.id === String(id ?? "").toLowerCase());
    if (!env) throw new HttpError(400, `Unknown environment "${id}".`);
    return env;
}

const str = (v, name) => {
    if (typeof v !== "string" || !v.trim() || v.length > 1024) throw new HttpError(400, `${name} is required`);
    return v;
};

function routesFor(ctx) {
    return {
        "GET /api/state": async () => ({ state: publicState(ctx) ?? publicState({ ...ctx, snapshot: await stateOf(ctx) }), refreshing: !!ctx.refreshing }),
        "GET /api/log": async ({ query }) => ({ lines: ctx.jobs.logOf(str(query.get("jobId"), "jobId")) }),
        "POST /api/refresh": async () => {
            refresh(ctx, { force: true }).catch((e) => log(`refresh failed: ${e.message}`, "warning"));
            return { ok: true };
        },
        "POST /api/compile": async ({ body }) => {
            await stateOf(ctx);
            const app = appByPath(ctx, str(body.appPath, "appPath"));
            return { jobId: ctx.jobs.compile(app.path).id };
        },
        "POST /api/publish": async ({ body }) => {
            await stateOf(ctx);
            if (!Array.isArray(body.appPaths) || !body.appPaths.length || body.appPaths.length > 50) throw new HttpError(400, "appPaths must be a non-empty list");
            const apps = body.appPaths.map((p) => appByPath(ctx, str(p, "appPath"))).sort((a, b) => a.order - b.order);
            const env = envById(ctx, str(body.environmentId, "environmentId"));
            const policy = canPublish(env, { actor: "user" });
            if (!policy.ok) throw new HttpError(409, policy.reason);
            if (body.mode != null && !["Add", "ForceSync"].includes(body.mode)) throw new HttpError(400, "mode must be Add or ForceSync");
            return { jobId: ctx.jobs.publish(apps.map((a) => a.path), env.id, { mode: body.mode, label: env.label }).id };
        },
        "POST /api/restart": async ({ body }) => {
            await stateOf(ctx);
            const env = envById(ctx, str(body.environmentId, "environmentId"));
            if (env.kind !== "container") throw new HttpError(400, "Only containers can be restarted");
            return { jobId: ctx.jobs.container("restart", env.id, (h) => ctx.publisher.restartContainer(env.id, h), `Restart ${env.label}`).id };
        },
        "POST /api/symbols": async ({ body }) => {
            await stateOf(ctx);
            const app = appByPath(ctx, str(body.appPath, "appPath"));
            const env = envById(ctx, str(body.environmentId, "environmentId"));
            if (env.kind !== "container" || env.state !== "running") throw new HttpError(409, "Symbols can only be downloaded from a running container");
            return { jobId: ctx.jobs.container("symbols", env.id, (h) => ctx.publisher.downloadSymbols(app.path, env.id, h), `Download symbols for ${app.name} from ${env.label}`).id };
        },
        "POST /api/cancel": async ({ body }) => ({ ok: ctx.jobs.cancel(str(body.jobId, "jobId")) }),
        "POST /api/ask-agent": async ({ body }) => {
            const runId = str(body.runId, "runId");
            const run = ctx.jobs.findRun(runId) ?? (await ctx.publisher.listRuns()).find((r) => r.id === runId);
            if (!run) throw new HttpError(404, "Run not found");
            if (run.ok) throw new HttpError(409, "That run succeeded");
            if (!session) throw new HttpError(503, "Session not ready");
            await session.send({ prompt: buildErrorPrompt(run) });
            return { ok: true };
        },
    };
}

function ctxForAction(instanceId) {
    const inst = instances.get(instanceId);
    if (!inst) throw new CanvasError("not_open", "Open the BC Publisher canvas first.");
    return inst.ctx;
}

const wrap = (fn) => async (req) => {
    try {
        return await fn(req);
    } catch (e) {
        if (e instanceof CanvasError) throw e;
        throw new CanvasError(e.code ?? (e instanceof HttpError ? "invalid_input" : "failed"), e.message);
    }
};

const canvas = createCanvas({
    id: "bc-publisher",
    displayName: "BC Publisher",
    description: "Overview of the workspace's AL apps and Business Central environments with deterministic compile and publish, usable by both the user and the agent.",
    inputSchema: {
        type: "object",
        properties: { workspaceRoot: { type: "string", description: "Folder containing the AL apps. Defaults to the git repository of the session's working directory." } },
        additionalProperties: false,
    },
    actions: [
        {
            name: "publisher_list_apps",
            description: "List AL apps in the workspace in dependency order (base apps first), with path, id, version and in-workspace dependencies.",
            handler: wrap(async ({ instanceId }) => (await stateOf(ctxForAction(instanceId))).apps),
        },
        {
            name: "publisher_list_environments",
            description: "List publish targets merged from launch.json, local BcContainerHelper containers and BC SaaS tenants. Includes isProduction, publishable (with reason) and agentMayPublish.",
            handler: wrap(async ({ instanceId }) =>
                (await stateOf(ctxForAction(instanceId))).environments.map((e) => ({
                    id: e.id, label: e.label, kind: e.kind, source: e.source, isProduction: e.isProduction, type: e.type ?? e.declaredType ?? null, state: e.state,
                    version: e.version ?? null, country: e.country ?? null, tenant: e.tenant?.label ?? null, publishable: e.publishable, agentMayPublish: e.agentMayPublish,
                })),
            ),
        },
        {
            name: "publisher_compile",
            description: "Compile one AL app with alc.exe (same code path as the Compile button). Returns ok, parsed diagnostics and the output file.",
            inputSchema: { type: "object", properties: { appPath: { type: "string", description: "App folder (from publisher_list_apps)" } }, required: ["appPath"], additionalProperties: false },
            handler: wrap(async ({ instanceId, input }) => {
                const ctx = ctxForAction(instanceId);
                await stateOf(ctx);
                const app = appByPath(ctx, input?.appPath);
                const job = await ctx.jobs.compile(app.path, { actor: "agent" }).done;
                const run = job.runs[0];
                if (!run) throw new CanvasError("failed", job.error ?? "Compile did not run");
                return { ok: run.ok, appName: run.appName, appVersion: run.appVersion, outFile: run.outFile, diagnostics: run.diagnostics, missingSymbols: run.missingSymbols, durationMs: run.durationMs, compilerVersion: run.compilerVersion, runId: run.id };
            }),
        },
        {
            name: "publisher_publish",
            description: "Compile and publish one AL app to an environment (same code path as the Publish button). Production is always refused. SaaS sandboxes ask the user to confirm; containers need agentMayPublish in config. Returns the run record.",
            inputSchema: {
                type: "object",
                properties: {
                    appPath: { type: "string", description: "App folder (from publisher_list_apps)" },
                    environmentId: { type: "string", description: "Environment id (from publisher_list_environments)" },
                    mode: { type: "string", enum: ["Add", "ForceSync"], description: "Schema sync mode (default Add, or the launch.json schemaUpdateMode)" },
                },
                required: ["appPath", "environmentId"],
                additionalProperties: false,
            },
            handler: wrap(async ({ instanceId, input }) => {
                const ctx = ctxForAction(instanceId);
                await stateOf(ctx);
                const app = appByPath(ctx, input?.appPath);
                const env = envById(ctx, input?.environmentId);
                let policy = canPublish(env, { actor: "agent" });
                let confirmed = false;
                if (!policy.ok && policy.needsConfirmation) {
                    if (!session?.capabilities?.ui?.elicitation) throw new CanvasError("needs_confirmation", "This host cannot ask for confirmation. Publish to SaaS sandboxes from the BC Publisher canvas instead.");
                    confirmed = await session.ui.confirm(`Allow the agent to publish "${app.name}" ${app.version} to the SaaS sandbox "${env.label}"${env.tenant ? ` (${env.tenant.label})` : ""}?`);
                    if (!confirmed) throw new CanvasError("declined", "The user declined publishing to this sandbox.");
                    policy = canPublish(env, { actor: "agent", confirmed });
                }
                if (!policy.ok) throw new CanvasError("refused", policy.reason);
                const job = await ctx.jobs.publish([app.path], env.id, { mode: input.mode, actor: "agent", confirmed, label: env.label }).done;
                const run = job.runs[0];
                if (!run) throw new CanvasError("failed", job.error ?? "Publish did not run");
                return run;
            }),
        },
        {
            name: "publisher_last_run",
            description: "Return the most recent publish run record for an environment (or null).",
            inputSchema: { type: "object", properties: { environmentId: { type: "string" } }, required: ["environmentId"], additionalProperties: false },
            handler: wrap(async ({ instanceId, input }) => ctxForAction(instanceId).publisher.getLastRun(str(input?.environmentId, "environmentId"))),
        },
    ],
    async open({ instanceId, input, session: sess }) {
        const requested = input && typeof input === "object" && typeof input.workspaceRoot === "string" && input.workspaceRoot.trim() ? input.workspaceRoot : null;
        // Default: the folder the session is working in, widened to its git repo so opening from a sub-folder still finds every app.
        const root = requested ? resolve(requested) : repoRootOf(resolve(sess?.workingDirectory ?? process.cwd()));
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new CanvasError("invalid_input", `Workspace folder not found: ${root}`);
        let inst = instances.get(instanceId);
        if (inst && inst.ctx.root.toLowerCase() !== root.toLowerCase()) {
            inst.ctx.servers.delete(inst.server);
            await inst.server.close();
            instances.delete(instanceId);
            inst = null;
        }
        if (!inst) {
            const ctx = contextFor(root);
            let server;
            try {
                server = await startUiServer({
                    uiDir,
                    routes: routesFor(ctx),
                    sse: async () => [["state", publicState(ctx)], ["status", { refreshing: !!ctx.refreshing }]],
                    log: (m) => log(m, "warning"),
                });
            } catch (e) {
                throw new CanvasError("server_failed", `Could not start the publisher UI server: ${e.message}`);
            }
            ctx.servers.add(server);
            inst = { server, ctx };
            instances.set(instanceId, inst);
        }
        if (!inst.ctx.snapshot) refresh(inst.ctx).catch((e) => log(`discovery failed: ${e.message}`, "warning"));
        return { url: inst.server.url, title: `BC Publisher — ${root.split(/[\\/]/).pop()}` };
    },
    async onClose({ instanceId }) {
        const inst = instances.get(instanceId);
        if (!inst) return;
        instances.delete(instanceId);
        inst.ctx.servers.delete(inst.server);
        await inst.server.close();
    },
});

/** `/bc-publisher [folder]` opens (or focuses) the canvas directly, without an agent turn. */
const openCommand = {
    name: "bc-publisher",
    description: "Open BC Publisher for this workspace (optionally: /bc-publisher <folder>)",
    handler: async ({ args }) => {
        const folder = String(args ?? "").trim().replace(/^["']|["']$/g, "");
        try {
            await session.rpc.canvas.open({ canvasId: "bc-publisher", instanceId: "bc-publisher", input: folder ? { workspaceRoot: folder } : {} });
        } catch (e) {
            log(`could not open the canvas: ${e.message}`, "warning");
        }
    },
};

session = await joinSession({ canvases: [canvas], commands: [openCommand] });
