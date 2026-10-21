import { API, orgUrl, projUrl } from "./azdo.mjs";
import { errMsg, mapLimit } from "./util.mjs";

const CLOSED_CATEGORIES = new Set(["Completed", "Removed"]);
const FALLBACK_CLOSED_STATES = ["Closed", "Done", "Removed", "Completed", "Inactive"];
const WI_FIELDS = [
    "System.Id",
    "System.Title",
    "System.WorkItemType",
    "System.State",
    "System.TeamProject",
    "System.IterationPath",
    "Microsoft.VSTS.Common.Priority",
    "System.ChangedDate",
];
const wiqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;
const stripRef = (ref) => (ref || "").replace(/^refs\/heads\//, "");

/**
 * Build a state-name → category map from the org's processes. A state name can map to several
 * categories across processes (e.g. "Completed" can be InProgress in one and Completed in another),
 * so values are Sets.
 */
export async function getStateCategories(client, org) {
    const procs = await client.get(`${orgUrl(org)}/_apis/work/processes?${API}`);
    const map = new Map();
    await mapLimit(procs.value ?? [], 4, async (p) => {
        const wits = await client.get(`${orgUrl(org)}/_apis/work/processes/${p.typeId}/workitemtypes?$expand=states&${API}`);
        for (const w of wits.value ?? []) {
            for (const s of w.states ?? []) {
                if (!map.has(s.name)) map.set(s.name, new Set());
                map.get(s.name).add(s.stateCategory);
            }
        }
    });
    return map;
}

/** Split state names into unambiguously closed ones (safe for WIQL) and ambiguous ones (resolve per type). */
export function classifyStates(categoryMap) {
    const closed = [];
    const ambiguous = new Set();
    for (const [name, cats] of categoryMap) {
        const closedish = [...cats].filter((c) => CLOSED_CATEGORIES.has(c)).length;
        if (closedish === cats.size) closed.push(name);
        else if (closedish > 0) ambiguous.add(name);
    }
    return { closed, ambiguous };
}

export function buildWiql({ closedStates, projects }) {
    let q = "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me";
    if (closedStates.length) q += ` AND [System.State] NOT IN (${closedStates.map(wiqlString).join(", ")})`;
    if (Array.isArray(projects)) q += ` AND [System.TeamProject] IN (${projects.map(wiqlString).join(", ")})`;
    return q + " ORDER BY [System.ChangedDate] DESC";
}

/** Flatten a project's iteration tree into { path, name, start, finish } using work-item-style paths ("Project\Sprint 1"). */
export function flattenIterations(root) {
    const out = [];
    const walk = (node, path) => {
        for (const c of node.children ?? []) {
            const p = `${path}\\${c.name}`;
            out.push({ path: p, name: c.name, start: c.attributes?.startDate ?? null, finish: c.attributes?.finishDate ?? null });
            walk(c, p);
        }
    };
    walk(root, root.name);
    return out;
}

/** Iterations whose dates contain `now`. Finish dates are whole days, so the finish day itself counts. Undated iterations never count. */
export function currentIterations(iterations, now) {
    return iterations.filter((i) => i.start && i.finish && Date.parse(i.start) <= now && now < Date.parse(i.finish) + 864e5);
}

async function fetchWorkItems(client, org, projects, errors, { sprintOnly = true, now = Date.now() } = {}) {
    let categories = new Map();
    let closed = FALLBACK_CLOSED_STATES;
    let ambiguous = new Set();
    try {
        categories = await getStateCategories(client, org);
        ({ closed, ambiguous } = classifyStates(categories));
    } catch (e) {
        errors.push({ org, area: "work item states", message: errMsg(e) });
    }
    const wiql = await client.post(`${orgUrl(org)}/_apis/wit/wiql?$top=200&${API}`, { query: buildWiql({ closedStates: closed, projects }) });
    const ids = (wiql.workItems ?? []).map((w) => w.id);
    const items = [];
    for (let i = 0; i < ids.length; i += 200) {
        const batch = await client.post(`${orgUrl(org)}/_apis/wit/workitemsbatch?${API}`, { ids: ids.slice(i, i + 200), fields: WI_FIELDS });
        items.push(...(batch.value ?? []));
    }
    // Resolve ambiguous states against the exact type definition in that project.
    const typeStates = new Map();
    const needs = [...new Set(items.filter((w) => ambiguous.has(w.fields["System.State"])).map((w) => `${w.fields["System.TeamProject"]}\u0000${w.fields["System.WorkItemType"]}`))];
    await mapLimit(needs, 4, async (k) => {
        const [project, type] = k.split("\u0000");
        try {
            const r = await client.get(`${projUrl(org, project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?${API}`);
            typeStates.set(k, new Map((r.value ?? []).map((s) => [s.name, s.category])));
        } catch (e) {
            errors.push({ org, project, area: "work item states", message: errMsg(e) });
        }
    });
    // Current sprint per project, from iteration dates (team-independent).
    const sprints = new Map();
    if (sprintOnly) {
        const projectNames = [...new Set(items.map((w) => w.fields["System.TeamProject"]))];
        await mapLimit(projectNames, 4, async (project) => {
            try {
                const root = await client.get(`${projUrl(org, project)}/_apis/wit/classificationnodes/Iterations?$depth=10&${API}`);
                for (const it of currentIterations(flattenIterations(root), now)) sprints.set(it.path.toLowerCase(), it);
            } catch (e) {
                errors.push({ org, project, area: "sprints", message: errMsg(e) });
            }
        });
    }
    return items
        .map((w) => {
            const f = w.fields;
            const project = f["System.TeamProject"];
            const state = f["System.State"];
            const exact = typeStates.get(`${project}\u0000${f["System.WorkItemType"]}`)?.get(state);
            const cats = categories.get(state);
            const stateCategory = exact ?? (cats && cats.size === 1 ? [...cats][0] : null);
            const sprint = sprints.get(String(f["System.IterationPath"] ?? "").toLowerCase()) ?? null;
            return {
                key: `wi:${org}/${w.id}`,
                org,
                id: w.id,
                title: f["System.Title"],
                type: f["System.WorkItemType"],
                state,
                stateCategory,
                project,
                iteration: f["System.IterationPath"],
                sprint: sprint && { name: sprint.name, start: sprint.start, finish: sprint.finish },
                priority: f["Microsoft.VSTS.Common.Priority"] ?? null,
                changedDate: f["System.ChangedDate"],
                url: `${projUrl(org, project)}/_workitems/edit/${w.id}`,
            };
        })
        .filter((w) => !CLOSED_CATEGORIES.has(w.stateCategory) && (!sprintOnly || w.sprint));
}

export function overallVote(reviewers = []) {
    const votes = reviewers.map((r) => r.vote ?? 0);
    if (votes.includes(-10)) return "rejected";
    if (votes.includes(-5)) return "waiting";
    if (reviewers.some((r) => r.isRequired && (r.vote ?? 0) <= 0)) return "pending";
    if (votes.some((v) => v >= 5)) return "approved";
    return "pending";
}

export const voteName = (v) => ({ 10: "approved", 5: "approved-suggestions", 0: "none", [-5]: "waiting", [-10]: "rejected" })[v ?? 0] ?? "none";

export function buildState(b) {
    if (!b) return "none";
    if (b.status && b.status !== "completed") return "running";
    if (b.result === "failed") return "failed";
    if (b.result === "partiallySucceeded") return "partial";
    if (b.result === "succeeded") return "succeeded";
    return "other";
}

function mapBuild(b, org, project) {
    return {
        id: b.id,
        number: b.buildNumber,
        definition: b.definition?.name ?? null,
        status: b.status,
        result: b.result ?? null,
        state: buildState(b),
        finishTime: b.finishTime ?? null,
        url: b._links?.web?.href ?? `${projUrl(org, project)}/_build/results?buildId=${b.id}`,
    };
}

/** Latest pipeline run for a PR: its validation build on refs/pull/N/merge, else the latest run on its source branch. */
async function latestPrBuild(client, base, pr) {
    const q = (branch) => client.get(`${base}/_apis/build/builds?branchName=${encodeURIComponent(branch)}&queryOrder=queueTimeDescending&$top=1&${API}`).then((r) => r.value?.[0] ?? null);
    return (await q(`refs/pull/${pr.pullRequestId}/merge`)) ?? (await q(pr.sourceRefName));
}

async function fetchProject(client, { org, project, meId, resolveRepo }) {
    const base = projUrl(org, project.name);
    const errors = [];
    const safe = async (area, fn, fallback) => {
        try {
            return await fn();
        } catch (e) {
            errors.push({ org, project: project.name, area, message: errMsg(e) });
            return fallback;
        }
    };
    const prQ = (who) => `${base}/_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.${who}=${meId}&$top=100&${API}`;
    const [created, reviewing] = await Promise.all([
        safe("pull requests", async () => (await client.get(prQ("creatorId"))).value ?? [], []),
        safe("pull requests", async () => (await client.get(prQ("reviewerId"))).value ?? [], []),
    ]);

    const prMap = new Map();
    for (const pr of [...created, ...reviewing]) {
        const e = prMap.get(pr.pullRequestId) ?? { pr, roles: new Set() };
        if (pr.createdBy?.id === meId) e.roles.add("author");
        if ((pr.reviewers ?? []).some((r) => r.id === meId)) e.roles.add("reviewer");
        prMap.set(pr.pullRequestId, e);
    }
    if (!prMap.size) return { pullRequests: [], errors };

    const repoMap = await safe("repositories", async () => new Map(((await client.get(`${base}/_apis/git/repositories?${API}`)).value ?? []).map((r) => [r.id, r])), new Map());
    const pullRequests = await mapLimit([...prMap.values()], 4, async ({ pr, roles }) => {
        const me = (pr.reviewers ?? []).find((r) => r.id === meId);
        const b = await safe("PR builds", () => latestPrBuild(client, base, pr), null);
        const repo = repoMap.get(pr.repository?.id);
        const remoteUrl = repo?.remoteUrl ?? null;
        return {
            key: `pr:${org}/${project.name}/${pr.pullRequestId}`,
            org,
            project: project.name,
            id: pr.pullRequestId,
            title: pr.title,
            repo: pr.repository?.name,
            repoId: pr.repository?.id,
            author: pr.createdBy?.displayName,
            sourceBranch: stripRef(pr.sourceRefName),
            targetBranch: stripRef(pr.targetRefName),
            isDraft: !!pr.isDraft,
            roles: [...roles],
            myVote: me ? voteName(me.vote) : null,
            voteState: overallVote(pr.reviewers),
            mergeStatus: pr.mergeStatus ?? "notSet",
            hasConflicts: pr.mergeStatus === "conflicts",
            build: b ? mapBuild(b, org, project.name) : null,
            createdDate: pr.creationDate,
            remoteUrl,
            localPath: remoteUrl ? await resolveRepo(remoteUrl).catch(() => null) : null,
            url: `${repo?.webUrl ?? `${base}/_git/${encodeURIComponent(pr.repository?.name ?? "")}`}/pullrequest/${pr.pullRequestId}`,
        };
    });
    return { pullRequests, errors };
}

/** Fetch everything for one configured organisation. Never throws for per-project failures. */
export async function fetchOrganisation(client, orgCfg, { resolveRepo, concurrency = 6, sprintOnly = true, now = Date.now() }) {
    const org = orgCfg.name;
    const errors = [];
    const conn = await client.get(`${orgUrl(org)}/_apis/connectionData`);
    const me = conn.authenticatedUser;
    if (!me?.id) throw new Error("connectionData returned no authenticated user");

    const all = [];
    let token = null;
    do {
        const page = await client.get(`${orgUrl(org)}/_apis/projects?$top=500${token ? `&continuationToken=${encodeURIComponent(token)}` : ""}&${API}`);
        all.push(...(page.value ?? []));
        token = page.continuationToken ?? null;
    } while (token);
    let projects = all;
    if (Array.isArray(orgCfg.projects)) {
        const byName = new Map(all.map((p) => [p.name.toLowerCase(), p]));
        projects = [];
        for (const name of orgCfg.projects) {
            const p = byName.get(name.toLowerCase());
            if (p) projects.push(p);
            else errors.push({ org, project: name, area: "projects", message: "Project not found or not accessible." });
        }
    }

    const [workItems, perProject] = await Promise.all([
        fetchWorkItems(client, org, Array.isArray(orgCfg.projects) ? projects.map((p) => p.name) : null, errors, { sprintOnly, now }).catch((e) => {
            errors.push({ org, area: "work items", message: errMsg(e) });
            return [];
        }),
        mapLimit(projects, concurrency, (project) => fetchProject(client, { org, project, meId: me.id, resolveRepo })),
    ]);
    return {
        me: { id: me.id, displayName: me.providerDisplayName ?? me.customDisplayName ?? null },
        workItems,
        pullRequests: perProject.flatMap((r) => r.pullRequests),
        errors: [...errors, ...perProject.flatMap((r) => r.errors)],
        projectCount: projects.length,
    };
}

/** PRs that need attention first: conflicts or a failed build, then running, then the rest, newest first. */
export function prUrgency(p) {
    if (p.hasConflicts || p.build?.state === "failed") return 0;
    if (p.roles.includes("reviewer") && !p.roles.includes("author") && p.myVote === "none") return 1;
    if (p.build?.state === "running") return 2;
    return 3;
}

export function sortBoard(board) {
    board.workItems.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || String(b.changedDate).localeCompare(String(a.changedDate)));
    board.pullRequests.sort((a, b) => prUrgency(a) - prUrgency(b) || String(b.createdDate).localeCompare(String(a.createdDate)));
    return board;
}
