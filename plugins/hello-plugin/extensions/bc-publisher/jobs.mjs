// Serial job runner for one workspace: compile / publish / container jobs with streamed logs and cancellation.
import { randomUUID } from "node:crypto";

const MAX_LOG = 3000;
const KEEP_FINISHED = 12;

export function createJobRunner({ publisher, emit }) {
    const jobs = [];
    let running = null;
    let pendingLog = new Map();
    let flushTimer = null;

    const flush = () => {
        flushTimer = null;
        for (const [jobId, lines] of pendingLog) emit("log", { jobId, lines });
        pendingLog = new Map();
    };
    const log = (job, line, stream = "stdout") => {
        const entry = { line, stream };
        job.log.push(entry);
        if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
        if (!pendingLog.has(job.id)) pendingLog.set(job.id, []);
        pendingLog.get(job.id).push(entry);
        flushTimer ??= setTimeout(flush, 80);
    };
    const summary = (j) => ({
        id: j.id, kind: j.kind, title: j.title, actor: j.actor, state: j.state, environmentId: j.environmentId ?? null, appPaths: j.appPaths ?? [],
        current: j.current ?? null, steps: j.steps, createdAt: j.createdAt, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null,
        error: j.error ?? null, runs: j.runs.map((r) => ({ id: r.id, ok: r.ok, kind: r.kind, appName: r.appName, appPath: r.appPath, environmentId: r.environmentId, phase: r.phase, diagnostics: r.diagnostics, missingSymbols: r.missingSymbols, error: r.error, durationMs: r.durationMs, command: r.command })),
    });
    const changed = (j) => emit("job", summary(j));

    async function pump() {
        if (running) return;
        const job = jobs.find((j) => j.state === "queued");
        if (!job) return;
        running = job;
        job.state = "running";
        job.startedAt = new Date().toISOString();
        changed(job);
        try {
            await job.exec(job);
            job.state = job.runs.some((r) => r.cancelled) ? "cancelled" : job.runs.some((r) => !r.ok) ? "failed" : "done";
        } catch (e) {
            job.error = e.message;
            job.state = job.controller.signal.aborted ? "cancelled" : "failed";
            log(job, e.message, "stderr");
        } finally {
            if (job.controller.signal.aborted && job.state !== "done") job.state = "cancelled";
            job.endedAt = new Date().toISOString();
            flush();
            changed(job);
            job.resolve(job);
            running = null;
            const finished = jobs.filter((j) => j.endedAt);
            for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.splice(jobs.indexOf(old), 1);
            setImmediate(pump);
        }
    }

    function enqueue({ kind, title, actor = "user", environmentId, appPaths, steps, exec }) {
        let resolve;
        const done = new Promise((r) => (resolve = r));
        const job = { id: randomUUID(), kind, title, actor, environmentId, appPaths, steps, exec, state: "queued", createdAt: new Date().toISOString(), log: [], runs: [], controller: new AbortController(), resolve, done };
        jobs.push(job);
        changed(job);
        setImmediate(pump);
        return job;
    }

    const hooks = (job) => ({
        onOutput: (line, stream) => log(job, line, stream),
        onPhase: (phase) => {
            job.state = phase;
            changed(job);
        },
        signal: job.controller.signal,
        actor: job.actor,
    });

    return {
        list: () => jobs.map(summary),
        logOf: (id) => jobs.find((j) => j.id === id)?.log ?? [],
        findRun: (runId) => jobs.flatMap((j) => j.runs).find((r) => r.id === runId) ?? null,
        cancel(id) {
            const j = jobs.find((x) => x.id === id);
            if (!j || j.endedAt) return false;
            j.controller.abort();
            if (j.state === "queued") {
                j.state = "cancelled";
                j.endedAt = new Date().toISOString();
                changed(j);
                j.resolve(j);
            }
            return true;
        },

        compile(appPath, { actor = "user" } = {}) {
            return enqueue({
                kind: "compile", title: `Compile ${appPath.split(/[\\/]/).pop()}`, actor, appPaths: [appPath], steps: ["queued", "compiling", "done"],
                exec: async (job) => {
                    job.current = appPath;
                    const run = await publisher.compileApp(appPath, hooks(job));
                    job.runs.push(run);
                    log(job, run.ok ? `✓ Compiled in ${(run.durationMs / 1000).toFixed(1)}s → ${run.outFile}` : `✗ ${run.error}`, run.ok ? "info" : "stderr");
                },
            });
        },

        /** Publish apps in dependency order; stop at the first failure. */
        publish(appPaths, environmentId, { mode, actor = "user", confirmed = false, label } = {}) {
            return enqueue({
                kind: "publish", title: `Publish ${appPaths.length === 1 ? appPaths[0].split(/[\\/]/).pop() : `${appPaths.length} apps`} → ${label ?? environmentId}`, actor, environmentId, appPaths,
                steps: ["queued", "compiling", "publishing", "done"],
                exec: async (job) => {
                    for (const appPath of appPaths) {
                        if (job.controller.signal.aborted) break;
                        job.current = appPath;
                        log(job, `── ${appPath}`, "info");
                        const run = await publisher.publishApp(appPath, environmentId, { ...hooks(job), mode, confirmed });
                        job.runs.push(run);
                        log(job, run.ok ? `✓ Published ${run.appName} ${run.appVersion} in ${(run.durationMs / 1000).toFixed(1)}s` : `✗ ${run.appName}: ${run.error}`, run.ok ? "info" : "stderr");
                        if (!run.ok) break;
                    }
                },
            });
        },

        container(kind, environmentId, fn, title) {
            return enqueue({
                kind, title, environmentId, steps: ["queued", "running", "done"],
                exec: async (job) => {
                    const r = await fn(hooks(job));
                    if (!r.ok) throw new Error(r.cancelled ? "Cancelled" : `${title} failed`);
                    log(job, `✓ ${title} finished`, "info");
                },
            });
        },
    };
}
