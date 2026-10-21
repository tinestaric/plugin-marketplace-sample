// BC Cockpit core: host-neutral. No Copilot imports here — this module is reused by other hosts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthError, createAuth } from "./auth.mjs";
import { API, createClient } from "./azdo.mjs";
import { fetchOrganisation, sortBoard } from "./board.mjs";
import { ConfigError, defaultHome, loadConfig as loadConfigFile } from "./config.mjs";
import { buildFixPrompt, getFailureDetails as prepareFailure } from "./failure.mjs";
import { buildConflictPrompt, getConflictDetails as prepareConflicts } from "./conflicts.mjs";
import { createRepoResolver } from "./repos.mjs";
import { atomicWrite, errMsg } from "./util.mjs";

export { AuthError, ConfigError, buildFixPrompt, buildConflictPrompt };
export { normaliseRemote } from "./repos.mjs";

const CACHE_FORMAT = "bc-cockpit-board-cache";
const CACHE_VERSION = 2;

function validBoard(b) {
    return b && typeof b === "object" && ["workItems", "pullRequests", "errors"].every((k) => Array.isArray(b[k])) && typeof b.fetchedAt === "string";
}

/**
 * Create a cockpit instance. Every dependency is injectable so tests can run against fixtures.
 * @param {{home?: string, fetch?: typeof fetch, run?: Function, env?: object, now?: () => number, scanRepos?: Function}} deps
 */
export function createCockpit({ home = defaultHome(), fetch = globalThis.fetch, run, env, now = () => Date.now(), scanRepos } = {}) {
    const auth = createAuth({ run, env, now });
    const client = createClient({ fetch, auth });
    const cacheFile = join(home, "cache.json");
    let config = null;
    let board = null;
    let inflight = null;

    async function discoverOrganisations() {
        const me = await client.get(`https://app.vssps.visualstudio.com/_apis/profile/profiles/me?${API}`);
        const accts = await client.get(`https://app.vssps.visualstudio.com/_apis/accounts?memberId=${me.id}&${API}`);
        return (accts.value ?? []).map((a) => a.accountName).filter(Boolean);
    }

    async function loadConfig() {
        config = await loadConfigFile({ home, discoverOrganisations });
        return config;
    }

    const repos = createRepoResolver({ getRoots: async () => (config ?? (await loadConfig())).repoRoots, now, ...(scanRepos ? { scan: scanRepos } : {}) });

    async function readCache() {
        let raw;
        try {
            raw = await readFile(cacheFile, "utf8");
        } catch {
            return null;
        }
        try {
            const j = JSON.parse(raw);
            if (j?.format !== CACHE_FORMAT || j.version !== CACHE_VERSION || !validBoard(j.board)) return null;
            return j.board;
        } catch {
            return null;
        }
    }

    async function fetchBoard() {
        const cfg = await loadConfig();
        const base = {
            config: { file: cfg.file, organisations: cfg.organisations.map((o) => o.name), sprintOnly: cfg.sprintOnly, refreshMinutes: cfg.refreshMinutes, repoRoots: cfg.repoRoots },
        };
        try {
            await auth.get();
        } catch (e) {
            if (!(e instanceof AuthError)) throw e;
            const prev = board ?? (await readCache());
            return {
                ...(prev ?? { workItems: [], pullRequests: [], me: {} }),
                ...base,
                fetchedAt: prev?.fetchedAt ?? new Date(now()).toISOString(),
                errors: [],
                auth: { ok: false, message: e.message, command: e.command, details: e.details },
                stale: !!prev,
            };
        }
        repos.clear();
        const perOrg = Math.max(1, Math.ceil(6 / Math.max(1, cfg.organisations.length)));
        const results = await Promise.all(
            cfg.organisations.map((o) =>
                fetchOrganisation(client, o, { resolveRepo: repos.resolve, concurrency: perOrg, sprintOnly: cfg.sprintOnly, now: now() }).catch((e) => ({
                    me: null,
                    workItems: [],
                    pullRequests: [],
                    errors: [{ org: o.name, area: "organisation", message: errMsg(e) }],
                    projectCount: 0,
                })),
            ),
        );
        const next = sortBoard({
            workItems: results.flatMap((r) => r.workItems),
            pullRequests: results.flatMap((r) => r.pullRequests),
            fetchedAt: new Date(now()).toISOString(),
            errors: results.flatMap((r) => r.errors),
            me: Object.fromEntries(cfg.organisations.map((o, i) => [o.name, results[i].me])),
            projectCount: results.reduce((n, r) => n + r.projectCount, 0),
            auth: { ok: true, method: auth.describe().method },
            ...base,
        });
        return next;
    }

    /** Current board; served from memory while fresh, otherwise fetched. Concurrent callers share one fetch. */
    async function getBoard({ force = false } = {}) {
        if (!force && board && config && now() - Date.parse(board.fetchedAt) < config.refreshMinutes * 60e3 && board.auth?.ok) return board;
        inflight ??= (async () => {
            const next = await fetchBoard();
            board = next;
            if (next.auth?.ok) {
                await atomicWrite(cacheFile, JSON.stringify({ format: CACHE_FORMAT, version: CACHE_VERSION, board: next })).catch(() => {});
            }
            return next;
        })().finally(() => (inflight = null));
        return inflight;
    }

    /** Last known board without touching the network (memory, then disk cache). */
    async function getCachedBoard() {
        if (board) return board;
        const cached = await readCache();
        return cached ? { ...cached, stale: true } : null;
    }

    async function getFailureDetails(buildRef) {
        const { org, project, buildId } = buildRef ?? {};
        if (typeof org !== "string" || !org || typeof project !== "string" || !project) throw new TypeError("org and project are required");
        const id = Number(buildId);
        if (!Number.isInteger(id) || id <= 0) throw new TypeError("buildId must be a positive integer");
        if (!config) await loadConfig();
        return prepareFailure(client, { org, project, buildId: id }, { resolveRepo: repos.resolve });
    }

    async function getConflictDetails(prRef) {
        const { org, project, repoId, prId } = prRef ?? {};
        if (typeof org !== "string" || !org || typeof project !== "string" || !project) throw new TypeError("org and project are required");
        if (typeof repoId !== "string" || !/^[0-9a-f-]{36}$/i.test(repoId)) throw new TypeError("repoId must be a repository GUID");
        const id = Number(prId);
        if (!Number.isInteger(id) || id <= 0) throw new TypeError("prId must be a positive integer");
        if (!config) await loadConfig();
        return prepareConflicts(client, { org, project, repoId, prId: id }, { resolveRepo: repos.resolve });
    }

    return {
        loadConfig,
        getBoard,
        getCachedBoard,
        getFailureDetails,
        getConflictDetails,
        buildFixPrompt,
        buildConflictPrompt,
        resolveLocalRepo: (remoteUrl) => repos.resolve(remoteUrl),
        get home() {
            return home;
        },
        isRefreshing: () => !!inflight,
    };
}

let shared = null;
const instance = () => (shared ??= createCockpit());

export const loadConfig = () => instance().loadConfig();
export const getBoard = (opts) => instance().getBoard(opts);
export const getFailureDetails = (buildRef) => instance().getFailureDetails(buildRef);
export const getConflictDetails = (prRef) => instance().getConflictDetails(prRef);
export const resolveLocalRepo = (remoteUrl) => instance().resolveLocalRepo(remoteUrl);
