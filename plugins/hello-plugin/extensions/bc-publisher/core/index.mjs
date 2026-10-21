// BC Publisher core: host-neutral. No Copilot imports here — this module is reused by other hosts.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { discoverApps as scanApps, workspaceFolders } from "./apps.mjs";
import { compile, findCompiler as locateCompiler, isAppFresh, buildCompileArgs, readAppJson } from "./compiler.mjs";
import { defaultHome, loadConfig as loadConfigFile, ConfigError } from "./config.mjs";
import { canPublish, containerDiscoveryScript, fetchSaasEnvironments, mergeEnvironments, parseContainerOutput, readLaunchTargets } from "./environments.mjs";
import { psq, runAz as defaultRunAz, runPwsh as defaultRunPwsh } from "./proc.mjs";
import { buildErrorPrompt } from "./prompt.mjs";
import { normaliseMode, publishToContainer, publishToSaas } from "./publish.mjs";
import { createRunStore } from "./runs.mjs";
import { errMsg } from "./util.mjs";

export { buildErrorPrompt, canPublish, ConfigError };
export { parseDiagnostics } from "./compiler.mjs";

export class PublishRefused extends Error {
    constructor(reason, { needsConfirmation = false } = {}) {
        super(reason);
        this.code = needsConfirmation ? "needs_confirmation" : "refused";
        this.needsConfirmation = needsConfirmation;
    }
}

const BC_RESOURCE = "https://api.businesscentral.dynamics.com";
const MAX_STORED_DIAGS = 200;

/**
 * Create a publisher bound to a workspace. All side-effecting dependencies are injectable for tests.
 */
export function createPublisher({
    workspaceRoot = process.cwd(),
    home = defaultHome(),
    fetch = globalThis.fetch,
    runAz = defaultRunAz,
    runPwsh = defaultRunPwsh,
    findCompiler = locateCompiler,
    now = () => Date.now(),
} = {}) {
    const root = resolve(workspaceRoot);
    const runs = createRunStore(home);
    const tokens = new Map();
    let config = null;
    let compiler = null;
    let apps = null;
    let envCache = null;

    async function getBcToken(tenant) {
        const hit = tokens.get(tenant);
        if (hit && hit.expiresAt - now() > 5 * 60e3) return hit.token;
        const out = await runAz(["account", "get-access-token", "--resource", BC_RESOURCE, "--tenant", tenant, "-o", "json"]).catch((e) => {
            throw new Error(`Could not get a Business Central token for tenant ${tenant} (run: az login --tenant ${tenant}). ${e.message}`);
        });
        const j = JSON.parse(out);
        const exp = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn);
        tokens.set(tenant, { token: j.accessToken, expiresAt: Number.isFinite(exp) ? exp : now() + 30 * 60e3 });
        return j.accessToken;
    }

    async function loadConfig() {
        config = await loadConfigFile({
            home,
            discoverTenant: async () => {
                const a = JSON.parse(await runAz(["account", "show", "-o", "json"]));
                return a?.tenantId ? { id: a.tenantId, label: a.tenantDisplayName || a.tenantDefaultDomain || "Home tenant" } : null;
            },
        });
        return config;
    }
    const cfg = async () => config ?? loadConfig();

    async function getCompiler({ force = false } = {}) {
        if (!compiler || force) compiler = await findCompiler({ override: (await cfg()).alcPath });
        return compiler;
    }

    async function discoverApps(workspace = root) {
        const list = await scanApps(workspace);
        if (resolve(workspace) === root) apps = list;
        return list;
    }

    async function workspaceInfo() {
        const ws = await workspaceFolders(root);
        return { root, name: ws.name, workspaceFile: ws.workspaceFile };
    }

    async function discoverEnvironments({ force = false } = {}) {
        if (envCache && !force) return envCache;
        const c = await loadConfig();
        const appList = apps ?? (await discoverApps());
        const errors = [];
        const [launch, containers, saas] = await Promise.all([
            readLaunchTargets(appList.map((a) => a.path), root),
            runPwsh(containerDiscoveryScript(appList.map((a) => a.id)), { timeoutMs: 180e3 })
                .then((r) => parseContainerOutput(r.lines))
                .catch((e) => {
                    errors.push({ source: "containers", message: errMsg(e) });
                    return null;
                }),
            fetchSaasEnvironments(c.tenants, { fetch, getToken: getBcToken }),
        ]);
        errors.push(...launch.errors, ...saas.errors);
        const environments = mergeEnvironments({ launch: launch.targets, containers, saas: saas.envs, config: c, tenantErrors: saas.errors });
        const order = { container: 0, saas: 1, onprem: 2 };
        environments.sort((a, b) => Number(a.isProduction) - Number(b.isProduction) || order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
        envCache = { environments, errors, fetchedAt: new Date(now()).toISOString() };
        return envCache;
    }

    async function getEnvironment(environmentId) {
        const id = String(environmentId ?? "").toLowerCase();
        let env = (await discoverEnvironments()).environments.find((e) => e.id === id);
        if (!env) env = (await discoverEnvironments({ force: true })).environments.find((e) => e.id === id);
        return env ?? null;
    }

    /** appPath must be one of the workspace's apps; this is the trust boundary for agent calls. */
    async function resolveApp(appPath) {
        if (typeof appPath !== "string" || !appPath.trim()) throw new Error("appPath is required");
        const list = apps ?? (await discoverApps());
        const want = resolve(root, appPath).toLowerCase();
        const app = list.find((a) => a.path.toLowerCase() === want);
        if (!app) throw new Error(`"${appPath}" is not an AL app in this workspace. Known apps: ${list.map((a) => a.path).join("; ") || "(none)"}`);
        return app;
    }

    function newRun(kind, app, extra) {
        return { id: randomUUID(), kind, appId: app.id, appName: app.name, appVersion: app.version, appPath: app.path, startedAt: new Date(now()).toISOString(), ...extra };
    }

    async function finish(run, startedMs, patch) {
        Object.assign(run, patch, { durationMs: now() - startedMs });
        if (run.diagnostics?.length > MAX_STORED_DIAGS) run.diagnostics = run.diagnostics.slice(0, MAX_STORED_DIAGS);
        try {
            await runs.add(run);
        } catch (e) {
            run.storageError = e.message;
        }
        return run;
    }

    /** Compile one app. Returns a run record with parsed diagnostics. */
    async function compileApp(appPath, { onOutput, onPhase, signal, actor = "user" } = {}) {
        const app = await resolveApp(appPath);
        const comp = await getCompiler();
        const run = newRun("compile", app, { environmentId: null, actor, phase: "compiling" });
        const t0 = now();
        onPhase?.("compiling", run);
        const r = await compile(app.path, { compiler: comp, workspaceRoot: root, onOutput, signal });
        return finish(run, t0, {
            ok: r.ok,
            cancelled: r.cancelled,
            phase: r.ok ? "done" : "compiling",
            command: r.command,
            compilerVersion: comp.version,
            diagnostics: r.diagnostics,
            missingSymbols: r.missingSymbols,
            outFile: r.outFile,
            tail: r.tail,
            error: r.ok ? null : r.cancelled ? "Cancelled" : `${r.diagnostics.filter((d) => d.severity === "error").length} compile error(s)`,
        });
    }

    /** Compile (unless fresh and skipCompile) and publish one app to one environment. */
    async function publishApp(appPath, environmentId, { mode, onOutput, onPhase, signal, skipCompile = false, actor = "user", confirmed = false } = {}) {
        const app = await resolveApp(appPath);
        const env = await getEnvironment(environmentId);
        if (!env) throw new PublishRefused(`Unknown environment "${environmentId}".`);
        const policy = canPublish(env, { actor, confirmed });
        if (!policy.ok) throw new PublishRefused(policy.reason, { needsConfirmation: policy.needsConfirmation });
        const syncMode = normaliseMode(mode, env);
        const comp = await getCompiler();
        const run = newRun("publish", app, { environmentId: env.id, environmentLabel: env.label, environmentKind: env.kind, actor, mode: syncMode, phase: "compiling" });
        const t0 = now();

        const { outFile } = await buildCompileArgs(app.path, { compiler: comp, app: await readAppJson(app.path), workspaceRoot: root });
        let appFile = outFile;
        let diagnostics = [];
        if (skipCompile && (await isAppFresh(app.path, outFile))) {
            onOutput?.(`Skipping compile: ${outFile} is newer than every source file.`, "info");
        } else {
            onPhase?.("compiling", run);
            const c = await compile(app.path, { compiler: comp, workspaceRoot: root, onOutput, signal });
            diagnostics = c.diagnostics;
            if (!c.ok) {
                return finish(run, t0, {
                    ok: false, cancelled: c.cancelled, phase: "compiling", command: c.command, compilerVersion: comp.version, diagnostics,
                    missingSymbols: c.missingSymbols, tail: c.tail, error: c.cancelled ? "Cancelled" : `${diagnostics.filter((d) => d.severity === "error").length} compile error(s)`,
                });
            }
            appFile = c.outFile;
        }

        run.phase = "publishing";
        onPhase?.("publishing", run);
        const p = env.kind === "container"
            ? await publishToContainer({ env, app, appFile, mode: syncMode, onOutput, signal, runPwsh })
            : await publishToSaas({ env, appFile, mode: syncMode, onOutput, signal, fetch, getToken: getBcToken });
        envCache = null;
        return finish(run, t0, { ok: p.ok, cancelled: !!p.cancelled, phase: p.ok ? "done" : "publishing", command: p.command, compilerVersion: comp.version, diagnostics, tail: p.tail, error: p.error });
    }

    async function containerJob(environmentId, script, { onOutput, signal }) {
        const env = await getEnvironment(environmentId);
        if (!env || env.kind !== "container") throw new PublishRefused(`"${environmentId}" is not a local container.`);
        const r = await runPwsh(`$ErrorActionPreference='Stop'\nImport-Module BcContainerHelper -DisableNameChecking 3>$null | Out-Null\n${script(env.details.containerName)}`, { onOutput, signal, timeoutMs: 30 * 60e3 });
        envCache = null;
        return { ok: !r.cancelled && r.code === 0, cancelled: r.cancelled, tail: r.lines.slice(-60) };
    }

    return {
        get workspaceRoot() {
            return root;
        },
        loadConfig,
        workspaceInfo,
        getCompiler,
        discoverApps,
        discoverEnvironments,
        getEnvironment,
        compileApp,
        publishApp,
        getLastRun: (environmentId) => runs.last(String(environmentId ?? "").toLowerCase()),
        listRuns: () => runs.list(),
        buildErrorPrompt,
        restartContainer: (environmentId, opts = {}) => containerJob(environmentId, (n) => `Restart-BcContainer -containerName ${psq(n)}`, opts),
        /** Download missing symbols for an app from a container into the app's .alpackages folder. */
        downloadSymbols: async (appPath, environmentId, opts = {}) => {
            const app = await resolveApp(appPath);
            return containerJob(
                environmentId,
                (n) => `Compile-AppInBcContainer -containerName ${psq(n)} -appProjectFolder ${psq(app.path)} -appSymbolsFolder ${psq(resolve(app.path, ".alpackages"))} -appOutputFolder ${psq(resolve(app.path, ".output"))} -updateSymbols | Out-Null`,
                opts,
            );
        },
    };
}

let shared = null;
const instance = () => (shared ??= createPublisher());

export const discoverApps = (workspaceRoot) => (workspaceRoot ? scanApps(workspaceRoot) : instance().discoverApps());
export const discoverEnvironments = (opts) => instance().discoverEnvironments(opts);
export const compileApp = (appPath, opts) => instance().compileApp(appPath, opts);
export const publishApp = (appPath, environmentId, opts) => instance().publishApp(appPath, environmentId, opts);
export const getLastRun = (environmentId) => instance().getLastRun(environmentId);
