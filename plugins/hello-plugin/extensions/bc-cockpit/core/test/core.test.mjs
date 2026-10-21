import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createCockpit, buildFixPrompt, buildConflictPrompt, normaliseRemote } from "../index.mjs";
import { normaliseConfig, loadConfig } from "../config.mjs";
import { createAuth, AuthError } from "../auth.mjs";
import { classifyStates, buildWiql, overallVote, flattenIterations, currentIterations, prUrgency } from "../board.mjs";
import { trimStepLog, combineTrimmed, selectFailedRecords, MAX_TRIMMED_BYTES } from "../failure.mjs";
import { parseGitConfigRemotes, scanRepoRoots } from "../repos.mjs";
import { stripJsonComments, stripAnsi, mapLimit } from "../util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(await readFile(join(here, "fixtures", "azdo.json"), "utf8"));
const logCompile = await readFile(join(here, "fixtures", "log-compile.txt"), "utf8");
const logTests = await readFile(join(here, "fixtures", "log-tests.txt"), "utf8");

const ORG = "https://dev.azure.com/contoso";
const A = `${ORG}/CustomerA-BC`;
const B = `${ORG}/Product%20Core`;

/** Fixture-backed fetch: routes by URL, records every call. */
function fixtureFetch() {
    const calls = [];
    const buildsFor = (url) => {
        const branch = decodeURIComponent(/branchName=([^&]+)/.exec(url)?.[1] ?? "");
        return { value: fx.buildsA.value.filter((b) => b.sourceBranch === branch).slice(0, 1) };
    };
    const routes = [
        [/\/_apis\/connectionData/, () => fx.connectionData],
        [/^https:\/\/dev\.azure\.com\/contoso\/_apis\/projects/, () => fx.projects],
        [/\/_apis\/work\/processes\/proc-agile\/workitemtypes/, () => fx.witsAgile],
        [/\/_apis\/work\/processes\/proc-custom\/workitemtypes/, () => fx.witsCustom],
        [/\/_apis\/work\/processes\?/, () => fx.processes],
        [/\/_apis\/wit\/wiql/, () => fx.wiql],
        [/\/_apis\/wit\/workitemsbatch/, () => fx.workitemsbatch],
        [/CustomerA-BC\/_apis\/wit\/classificationnodes\/Iterations/, () => fx.iterationsA],
        [/Product%20Core\/_apis\/wit\/classificationnodes\/Iterations/, () => fx.iterationsB],
        [/Product%20Core\/_apis\/wit\/workitemtypes\/Task\/states/, () => fx.typeStatesTask],
        [/CustomerA-BC\/_apis\/wit\/workitemtypes\/User%20Story\/states/, () => fx.typeStatesStory],
        [/CustomerA-BC\/_apis\/git\/pullrequests\?.*creatorId/, () => fx.prsCreatorA],
        [/CustomerA-BC\/_apis\/git\/pullrequests\?.*reviewerId/, () => fx.prsReviewerA],
        [/Product%20Core\/_apis\/git\/pullrequests/, () => ({ value: [] })],
        [/CustomerA-BC\/_apis\/build\/builds\?.*branchName=/, buildsFor],
        [/CustomerA-BC\/_apis\/git\/repositories\?/, () => fx.repositoriesA],
        [/CustomerA-BC\/_apis\/git\/repositories\/repo-a\/pullRequests\/7\/conflicts/, () => fx.conflicts7],
        [/CustomerA-BC\/_apis\/git\/repositories\/repo-a\/pullrequests\/7\?/, () => fx.pr7full],
        [/CustomerA-BC\/_apis\/git\/repositories\/repo-a\?/, () => fx.repositoriesA.value[0]],
        [/\/builds\/501\/timeline/, () => fx.timeline501],
        [/\/builds\/501\/logs\/11/, () => logCompile],
        [/\/builds\/501\/logs\/12/, () => logTests],
        [/\/builds\/501\?/, () => fx.build501],
    ];
    const fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body });
        const r = routes.find(([re]) => re.test(url));
        if (!r) return new Response(JSON.stringify({ message: `no fixture for ${url}` }), { status: 404 });
        const body = r[1](url);
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    };
    return { fetch, calls };
}

const NOW = Date.parse("2026-10-21T10:00:00Z");

const fakeAz = async () => JSON.stringify({ accessToken: "tok", expires_on: Math.floor(Date.now() / 1000) + 3600 });

async function tempHome(config) {
    const home = await mkdtemp(join(tmpdir(), "bc-cockpit-test-"));
    if (config) await writeFile(join(home, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
    return home;
}

// ---------- util / config ----------

test("stripJsonComments keeps comment-like text inside strings", () => {
    const parsed = JSON.parse(stripJsonComments('// top\n{ "a": "http://x//y", /* c */ "b": [1,2,], }'));
    assert.deepEqual(parsed, { a: "http://x//y", b: [1, 2] });
});

test("stripAnsi removes colour codes", () => {
    assert.equal(stripAnsi("\x1b[31merror\x1b[0m done"), "error done");
});

test("mapLimit respects the concurrency limit and keeps order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, n));
        active--;
        return n * 2;
    });
    assert.deepEqual(out, [10, 2, 8, 4, 6, 12, 14]);
    assert.ok(peak <= 3);
});

test("normaliseConfig validates shape and fills defaults", () => {
    const c = normaliseConfig({ organisations: [{ name: "contoso" }, { name: "x", projects: ["A "] }], pipelineScope: "mine" });
    assert.deepEqual(c.organisations, [{ name: "contoso", projects: "*" }, { name: "x", projects: ["A"] }]);
    assert.equal(c.refreshMinutes, 3);
    assert.equal(c.sprintOnly, true, "old configs with pipelineScope still load");
    assert.equal(normaliseConfig({ sprintOnly: false }).sprintOnly, false);
    assert.throws(() => normaliseConfig({ sprintOnly: "yes" }), /sprintOnly/);
    assert.throws(() => normaliseConfig({ organisations: [{ name: "bad/name" }] }), /organisation name/);
});

test("loadConfig creates a commented starter file on first run", async () => {
    const home = await tempHome();
    const c = await loadConfig({ home, discoverOrganisations: async () => ["contoso", "fabrikam"] });
    assert.equal(c.created, true);
    assert.deepEqual(c.organisations.map((o) => o.name), ["contoso", "fabrikam"]);
    const text = await readFile(join(home, "config.json"), "utf8");
    assert.match(text, /^\/\/ BC Cockpit configuration/);
    assert.doesNotMatch(text, /token|password/i);
    const again = await loadConfig({ home });
    assert.equal(again.created, false);
    await rm(home, { recursive: true, force: true });
});

// ---------- auth ----------

test("auth prefers az, falls back to AZDO_PAT, then reports not signed in", async () => {
    const az = createAuth({ run: fakeAz, env: {} });
    assert.equal((await az.get()).header, "Bearer tok");

    const pat = createAuth({ run: async () => { throw new Error("az not found"); }, env: { AZDO_PAT: "secret" } });
    const t = await pat.get();
    assert.equal(t.method, "pat");
    assert.equal(t.header, `Basic ${Buffer.from(":secret").toString("base64")}`);

    const none = createAuth({ run: async () => { throw new Error("Please run az login"); }, env: {} });
    await assert.rejects(none.get(), (e) => e instanceof AuthError && e.command === "az login");
});

test("auth caches the token until shortly before expiry", async () => {
    let calls = 0;
    let clock = 0;
    const run = async () => (calls++, JSON.stringify({ accessToken: `t${calls}`, expires_on: 3600 }));
    const auth = createAuth({ run, env: {}, now: () => clock });
    await auth.get();
    clock = 1000e3;
    await auth.get();
    assert.equal(calls, 1);
    clock = 3600e3 - 60e3;
    assert.equal((await auth.get()).header, "Bearer t2");
});

// ---------- board logic ----------

test("classifyStates separates unambiguous closed states from ambiguous ones", () => {
    const m = new Map([["Closed", new Set(["Completed"])], ["Completed", new Set(["Completed", "InProgress"])], ["Active", new Set(["InProgress"])], ["Removed", new Set(["Removed"])]]);
    const { closed, ambiguous } = classifyStates(m);
    assert.deepEqual(closed.sort(), ["Closed", "Removed"]);
    assert.deepEqual([...ambiguous], ["Completed"]);
    const q = buildWiql({ closedStates: closed, projects: ["O'Brien"] });
    assert.match(q, /\[System\.AssignedTo\] = @Me/);
    assert.match(q, /\[System\.TeamProject\] IN \('O''Brien'\)/);
});

test("overallVote ranks rejection over waiting over approval", () => {
    assert.equal(overallVote([{ vote: 10 }, { vote: -10 }]), "rejected");
    assert.equal(overallVote([{ vote: 10 }, { vote: -5 }]), "waiting");
    assert.equal(overallVote([{ vote: 10 }, { vote: 0, isRequired: true }]), "pending");
    assert.equal(overallVote([{ vote: 5 }, { vote: 0 }]), "approved");
    assert.equal(overallVote([]), "pending");
});

test("flattenIterations + currentIterations find the dated sprint containing today (finish day inclusive)", () => {
    const flat = flattenIterations(fx.iterationsB);
    assert.deepEqual(flat.map((i) => i.path), ["Product Core\\Release", "Product Core\\Release\\Sprint 9"]);
    const at = (iso) => currentIterations([...flattenIterations(fx.iterationsA), ...flat], Date.parse(iso)).map((i) => i.path);
    assert.deepEqual(at("2026-10-21T10:00:00Z"), ["CustomerA-BC\\Sprint 4", "Product Core\\Release\\Sprint 9"]);
    assert.deepEqual(at("2026-10-21T23:30:00Z"), ["CustomerA-BC\\Sprint 4", "Product Core\\Release\\Sprint 9"], "finish day counts");
    assert.deepEqual(at("2026-10-22T00:30:00Z"), ["CustomerA-BC\\Sprint 4"]);
    assert.deepEqual(at("2026-10-17T12:00:00Z"), ["Product Core\\Release\\Sprint 9"], "CustomerA is between sprints");
    assert.deepEqual(at("2026-11-02T12:00:00Z"), [], "no sprint planned");
});

test("prUrgency puts conflicts and failed pipelines first, then reviews waiting on me", () => {
    const base = { roles: ["author"], myVote: null, hasConflicts: false, build: null };
    assert.equal(prUrgency({ ...base, hasConflicts: true }), 0);
    assert.equal(prUrgency({ ...base, build: { state: "failed" } }), 0);
    assert.equal(prUrgency({ ...base, roles: ["reviewer"], myVote: "none" }), 1);
    assert.equal(prUrgency({ ...base, build: { state: "running" } }), 2);
    assert.equal(prUrgency(base), 3);
});

// ---------- failure trimming ----------

test("trimStepLog extracts AL diagnostics, errors first, de-duplicated", () => {
    const r = trimStepLog(logCompile);
    assert.equal(r.alErrors, 2);
    assert.equal(r.alWarnings, 1);
    const lines = r.text.split("\n");
    assert.match(lines[0], /error AL0118/);
    assert.match(lines[1], /error AL0132/);
    assert.match(lines[2], /warning AL0432/);
    assert.doesNotMatch(r.text, /Task {9}:|2026-10-20T/);
});

test("trimStepLog extracts AL test failure blocks with call stack", () => {
    const r = trimStepLog(logTests);
    assert.equal(r.testFailures, 1);
    assert.match(r.text, /Codeunit 50100 VAT Tests :: TestInvalidVatNo/);
    assert.match(r.text, /Assert\.AreEqual failed/);
    assert.match(r.text, /Call Stack:/);
    assert.doesNotMatch(r.text, /TestValidVatNo|TestPost/);
});

test("trimStepLog falls back to the last 40 meaningful lines and surfaces reported issues", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const r = trimStepLog(log, { issues: ["Header not documented", "PowerShell exited with code '1'."] });
    const lines = r.text.split("\n");
    assert.equal(lines[0], "reported: Header not documented");
    assert.equal(lines.length, 41);
    assert.equal(lines.at(-1), "line 99");
    assert.equal(lines[1], "line 60");
});

test("combineTrimmed caps output at ~8 KB, dropping warnings first", () => {
    const warn = Array.from({ length: 400 }, (_, i) => `src/F${i}.al(1,1): warning AL0432: something deprecated number ${i}`).join("\n");
    const err = "src/A.al(1,1): error AL0118: boom";
    const out = combineTrimmed([{ name: "Compile", log: `${err}\n${warn}` }]);
    assert.ok(Buffer.byteLength(out) <= MAX_TRIMMED_BYTES);
    assert.match(out, /error AL0118/);
    assert.doesNotMatch(out, /warning AL0432/);
    const big = combineTrimmed([{ name: "Compile", log: Array.from({ length: 500 }, (_, i) => `x.al(1,1): error AL0001: e${i}`).join("\n") }]);
    assert.ok(Buffer.byteLength(big) <= MAX_TRIMMED_BYTES);
    assert.match(big, /… \(truncated\)$/);
});

test("selectFailedRecords returns failed tasks in execution order", () => {
    assert.deepEqual(selectFailedRecords(fx.timeline501).map((r) => r.name), ["Compile app", "Run tests"]);
});

// ---------- repos ----------

test("normaliseRemote collapses every Azure DevOps and GitHub URL form", () => {
    const key = "azdo:contoso/customer a/app";
    for (const u of [
        "https://dev.azure.com/contoso/Customer%20A/_git/app",
        "https://contoso@dev.azure.com/contoso/Customer%20A/_git/app",
        "https://contoso.visualstudio.com/Customer%20A/_git/app",
        "https://contoso.visualstudio.com/DefaultCollection/Customer%20A/_git/app.git",
        "git@ssh.dev.azure.com:v3/contoso/Customer%20A/app",
        "contoso@vs-ssh.visualstudio.com:v3/contoso/Customer%20A/app",
    ]) assert.equal(normaliseRemote(u), key, u);
    assert.equal(normaliseRemote("git@github.com:Owner/Repo.git"), "github:owner/repo");
    assert.equal(normaliseRemote("https://github.com/owner/repo"), "github:owner/repo");
});

test("parseGitConfigRemotes reads only remote urls", () => {
    const text = '[core]\n\turl = nope\n[remote "origin"]\n\turl = https://dev.azure.com/c/p/_git/r\n\tfetch = +refs/heads/*\n[remote "up"]\n\turl = git@github.com:o/r.git\n';
    assert.deepEqual(parseGitConfigRemotes(text), ["https://dev.azure.com/c/p/_git/r", "git@github.com:o/r.git"]);
});

test("scanRepoRoots finds clones one level deep, including worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "bc-cockpit-repos-"));
    await mkdir(join(root, "app", ".git"), { recursive: true });
    await writeFile(join(root, "app", ".git", "config"), '[remote "origin"]\n\turl = https://contoso@dev.azure.com/contoso/CustomerA-BC/_git/customer-a-app\n');
    await mkdir(join(root, "gitdirs", "wt"), { recursive: true });
    await writeFile(join(root, "gitdirs", "wt", "commondir"), "../main");
    await mkdir(join(root, "gitdirs", "main"), { recursive: true });
    await writeFile(join(root, "gitdirs", "main", "config"), '[remote "origin"]\n\turl = git@github.com:o/wt.git\n');
    await mkdir(join(root, "worktree"));
    await writeFile(join(root, "worktree", ".git"), `gitdir: ${join(root, "gitdirs", "wt")}\n`);
    await mkdir(join(root, "deep", "nested", ".git"), { recursive: true });
    await writeFile(join(root, "deep", "nested", ".git", "config"), '[remote "origin"]\n\turl = https://dev.azure.com/c/p/_git/deep\n');
    const map = await scanRepoRoots([root]);
    assert.equal(map.get("azdo:contoso/customera-bc/customer-a-app"), join(root, "app"));
    assert.equal(map.get("github:o/wt"), join(root, "worktree"));
    assert.equal(map.has("azdo:c/p/deep"), false);
    await rm(root, { recursive: true, force: true });
});

// ---------- end to end against fixtures ----------

function fixtureCockpit(home, extra = {}) {
    const { fetch, calls } = fixtureFetch();
    const scanRepos = async () => new Map([["azdo:contoso/customera-bc/customer-a-app", "C:/Repos/customer-a-app"]]);
    return { cockpit: createCockpit({ home, fetch, run: fakeAz, env: {}, scanRepos, now: () => NOW, ...extra }), calls };
}

test("getBoard shows current-sprint work items and PRs with merge and pipeline status", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso", projects: "*" }], repoRoots: [] });
    const { cockpit, calls } = fixtureCockpit(home);
    const b = await cockpit.getBoard({ force: true });

    assert.equal(b.auth.ok, true);
    assert.deepEqual(b.errors, []);
    assert.equal(b.projectCount, 2);
    assert.equal(b.pipelines, undefined, "pipelines are part of PRs now");
    // 102 is in last sprint → hidden; 104 is Completed → hidden; 103 is InProgress for Task in a current nested sprint → kept.
    assert.deepEqual(b.workItems.map((w) => w.id), [101, 103]);
    assert.deepEqual(b.workItems[0].sprint, { name: "Sprint 4", start: "2026-10-19T00:00:00Z", finish: "2026-10-30T00:00:00Z" });
    assert.equal(b.workItems[1].sprint.name, "Sprint 9");
    assert.equal(b.workItems[1].stateCategory, "InProgress");
    assert.equal(b.workItems[0].url, `${ORG}/CustomerA-BC/_workitems/edit/101`);

    const wiql = calls.find((c) => c.url.includes("/_apis/wit/wiql"));
    assert.match(JSON.parse(wiql.body).query, /NOT IN \('Closed', 'Removed', 'Done'\)/);

    assert.deepEqual(b.pullRequests.map((p) => p.id), [7, 9], "conflicts/failed first");
    const mine = b.pullRequests[0];
    assert.deepEqual(mine.roles.sort(), ["author", "reviewer"]);
    assert.equal(mine.hasConflicts, true);
    assert.deepEqual([mine.build.id, mine.build.state, mine.build.definition], [501, "failed", "CustomerA CI"]);
    assert.equal(mine.repoId, "repo-a");
    assert.equal(mine.localPath, "C:/Repos/customer-a-app");
    assert.equal(mine.url, "https://dev.azure.com/contoso/CustomerA-BC/_git/customer-a-app/pullrequest/7");
    const waiting = b.pullRequests[1];
    assert.deepEqual(waiting.roles, ["reviewer"]);
    assert.equal(waiting.myVote, "none");
    assert.equal(waiting.voteState, "waiting");
    assert.equal(waiting.build, null, "no PR build and no branch build");
    assert.ok(calls.some((c) => /branchName=refs%2Fheads%2Fdev%2Fprice/.test(c.url)), "falls back to the source branch");
    assert.ok(!calls.some((c) => /Product%20Core\/_apis\/build/.test(c.url)), "no build queries for projects without PRs");

    assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${"tok"}`));
    assert.ok(calls.every((c) => c.method === "GET" || /wiql|workitemsbatch/.test(c.url)), "cockpit only writes read queries");

    const cache = JSON.parse(await readFile(join(home, "cache.json"), "utf8"));
    assert.equal(cache.format, "bc-cockpit-board-cache");
    assert.doesNotMatch(JSON.stringify(cache), /Bearer|tok"/);
    await rm(home, { recursive: true, force: true });
});

test("sprintOnly: false shows every open work item", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso" }], sprintOnly: false });
    const { cockpit, calls } = fixtureCockpit(home);
    const b = await cockpit.getBoard({ force: true });
    assert.deepEqual(b.workItems.map((w) => w.id), [102, 101, 103]);
    assert.ok(!calls.some((c) => c.url.includes("classificationnodes")));
    await rm(home, { recursive: true, force: true });
});

test("getBoard isolates per-project failures into errors", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso", projects: ["CustomerA-BC", "Missing"] }] });
    const { fetch } = fixtureFetch();
    const flaky = async (url, init) => (/CustomerA-BC\/_apis\/build/.test(url) ? new Response('{"message":"boom"}', { status: 500 }) : fetch(url, init));
    const cockpit = createCockpit({ home, fetch: flaky, run: fakeAz, env: {}, scanRepos: async () => new Map(), now: () => NOW });
    const b = await cockpit.getBoard({ force: true });
    assert.equal(b.pullRequests.length, 2);
    assert.ok(b.pullRequests.every((p) => p.build === null));
    assert.ok(b.errors.some((e) => e.area === "PR builds" && /500.*boom/.test(e.message)));
    assert.ok(b.errors.some((e) => e.project === "Missing"));
    await rm(home, { recursive: true, force: true });
});

test("getConflictDetails lists conflicting files and builds a resolve prompt", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso" }] });
    const { cockpit, calls } = fixtureCockpit(home);
    await assert.rejects(cockpit.getConflictDetails({ org: "contoso", project: "CustomerA-BC", repoId: "repo-a", prId: 7 }), /repoId must be a repository GUID/);
    const guidCockpit = createCockpit({
        home,
        run: fakeAz,
        env: {},
        now: () => NOW,
        scanRepos: async () => new Map([["azdo:contoso/customera-bc/customer-a-app", "C:/Repos/customer-a-app"]]),
        fetch: (url, init) => fixtureFetch().fetch(url.replace("00000000-0000-0000-0000-00000000000a", "repo-a"), init),
    });
    const d = await guidCockpit.getConflictDetails({ org: "contoso", project: "CustomerA-BC", repoId: "00000000-0000-0000-0000-00000000000a", prId: 7 });
    assert.deepEqual(d.files, ["src/Vat/VatCheck.Codeunit.al", "app.json"]);
    assert.equal(d.sourceBranch, "feature/vat");
    assert.equal(d.targetBranch, "main");
    assert.equal(d.localPath, "C:/Repos/customer-a-app");
    const prompt = buildConflictPrompt(d);
    assert.match(prompt, /^Pull request !7 "Add VAT validation" .* feature\/vat has merge conflicts with main\./);
    assert.match(prompt, /- src\/Vat\/VatCheck\.Codeunit\.al\n- app\.json/);
    assert.match(prompt, /merge origin\/main into it/);
    assert.match(prompt, /Do not push\.$/);
    assert.equal(calls.length, 0);
    await rm(home, { recursive: true, force: true });
});

test("getBoard reports a not-signed-in state with the command to run", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso" }] });
    const cockpit = createCockpit({ home, fetch: async () => { throw new Error("no network"); }, run: async () => { throw new Error("az login"); }, env: {} });
    const b = await cockpit.getBoard({ force: true });
    assert.equal(b.auth.ok, false);
    assert.equal(b.auth.command, "az login");
    await rm(home, { recursive: true, force: true });
});

test("getCachedBoard paints from disk without network", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso" }] });
    await fixtureCockpit(home).cockpit.getBoard({ force: true });
    const offline = createCockpit({ home, fetch: async () => { throw new Error("offline"); }, run: fakeAz, env: {} });
    const b = await offline.getCachedBoard();
    assert.equal(b.stale, true);
    assert.equal(b.workItems.length, 2);
    await rm(home, { recursive: true, force: true });
});

test("getFailureDetails prepares branch, commit, trimmed log and local clone", async () => {
    const home = await tempHome({ organisations: [{ name: "contoso" }] });
    const { cockpit } = fixtureCockpit(home);
    const f = await cockpit.getFailureDetails({ org: "contoso", project: "CustomerA-BC", buildId: 501 });
    assert.equal(f.branch, "feature/vat");
    assert.equal(f.commit, "abc123def4567890");
    assert.equal(f.prId, 7);
    assert.equal(f.localPath, "C:/Repos/customer-a-app");
    assert.deepEqual(f.failedSteps.map((s) => s.name), ["Compile app", "Run tests"]);
    assert.match(f.trimmedLog, /### Compile app\n.*error AL0118/);
    assert.match(f.trimmedLog, /### Run tests\n.*TestInvalidVatNo/);
    await assert.rejects(cockpit.getFailureDetails({ org: "contoso", project: "x", buildId: "abc" }), /buildId/);

    const prompt = buildFixPrompt(f);
    assert.match(prompt, /^The pipeline "CustomerA CI" failed on branch feature\/vat at commit abc123def4/);
    assert.match(prompt, /error AL0118/);
    assert.match(prompt, /The local clone is at C:\/Repos\/customer-a-app\./);
    assert.match(prompt, /Do not push\.$/);
    await rm(home, { recursive: true, force: true });
});
