import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublisher, buildErrorPrompt, canPublish, PublishRefused } from "../index.mjs";
import { discoverApps, orderByDependencies } from "../apps.mjs";
import { parseDiagnostics, hasMissingSymbols, findCompiler, buildCompileArgs, isAppFresh } from "../compiler.mjs";
import { parseLaunchJson, mergeEnvironments, parseContainerOutput, containerDiscoveryScript } from "../environments.mjs";
import { normaliseConfig } from "../config.mjs";
import { containerPublishScript, normaliseMode } from "../publish.mjs";
import { createRunStore, MAX_RUNS } from "../runs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFile(join(here, "fixtures", n), "utf8");
const alcOutput = await fixture("alc-output.txt");
const adminEnvs = JSON.parse(await fixture("admin-environments.json"));

// Stand-in for alc.exe, written at test time so `node --test` does not pick it up as a test file.
// It fails when the project contains a BROKEN marker, otherwise writes the /out file.
const FAKE_ALC = join(await mkdtemp(join(tmpdir(), "bc-publisher-alc-")), "fake-alc.mjs");
await writeFile(
    FAKE_ALC,
    `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arg = (n) => process.argv.find((a) => a.toLowerCase().startsWith("/" + n + ":"))?.slice(n.length + 2);
const project = arg("project");
console.log("Microsoft (R) AL Compiler version 99.0.0.0");
if (existsSync(join(project, "BROKEN"))) {
  console.log(join(project, "src", "Thing.Codeunit.al") + "(7,9): error AL0118: The name 'UndefinedThing' does not exist in the current context");
  process.exit(1);
}
writeFileSync(arg("out"), "fake app");
console.log("Compilation ended.");
`,
);

const T = "11111111-1111-1111-1111-111111111111";
const IDS = { base: "aaaaaaaa-0000-0000-0000-000000000001", ext: "aaaaaaaa-0000-0000-0000-000000000002", tests: "aaaaaaaa-0000-0000-0000-000000000003" };

const appJson = (id, name, deps = []) => JSON.stringify({ id, name, publisher: "Contoso", version: "1.0.0.1", idRanges: [{ from: 50100, to: 50149 }], runtime: "14.0", dependencies: deps.map((d) => ({ id: d, name: "dep", publisher: "Contoso", version: "1.0.0.0" })) });

const LAUNCH = `{
  // comments are allowed in launch.json
  "version": "0.2.0",
  "configurations": [
    { "name": "Dev sandbox (Customer A)", "type": "al", "request": "launch", "environmentType": "Sandbox", "environmentName": "dev", "tenant": "${T}", "schemaUpdateMode": "ForceSync" },
    { "name": "Customer A PROD", "type": "al", "request": "launch", "environmentType": "Production", "environmentName": "production", "tenant": "${T}" },
    { "name": "Local container", "type": "al", "request": "launch", "environmentType": "OnPrem", "server": "http://bcdev", "serverInstance": "BC", "authentication": "UserPassword" },
    { "name": "Test server", "type": "al", "request": "launch", "environmentType": "OnPrem", "server": "https://bc.contoso.com", "serverInstance": "BC250" },
    { "name": "Unknown sandbox", "type": "al", "request": "launch", "environmentType": "Sandbox", "environmentName": "sandbox" },
    { "name": "Prod without tenant", "type": "al", "request": "launch", "environmentType": "Production", "environmentName": "prod2" },
    { "name": "Attach", "type": "al", "request": "attach" },
    { "name": "Node thing", "type": "node", "request": "launch" },
  ]
}`;

/** Build a throw-away AL workspace: base ← ext ← tests, plus noise that discovery must skip. */
async function makeWorkspace() {
    const ws = await mkdtemp(join(tmpdir(), "bc-publisher-ws-"));
    const w = async (p, text) => {
        await mkdir(dirname(join(ws, p)), { recursive: true });
        await writeFile(join(ws, p), text);
    };
    await w("Demo.code-workspace", `{ // workspace\n "folders": [ { "path": "apps/tests" }, { "path": "apps/ext" }, { "path": "apps/base" } ] }`);
    await w("apps/base/app.json", "\uFEFF" + appJson(IDS.base, "Base App"));
    await w("apps/base/.alpackages/app.json", appJson("ffffffff-0000-0000-0000-000000000000", "Should be skipped"));
    await w("apps/ext/app.json", appJson(IDS.ext, "Extension App", [IDS.base, "99999999-0000-0000-0000-000000000000"]));
    await w("apps/ext/.vscode/launch.json", LAUNCH);
    await w("apps/ext/.vscode/settings.json", `{ "al.ruleSetPath": "./custom.ruleset.json", "al.enableCodeAnalysis": true, "al.codeAnalyzers": ["\${CodeCop}", "\${UICop}", "./analyzers/My.dll"], "al.packageCachePath": ["./.alpackages", "../shared-symbols"] }`);
    await w("apps/ext/src/Thing.Codeunit.al", "codeunit 50100 Thing {}");
    await w("apps/tests/app.json", appJson(IDS.tests, "Test App", [IDS.ext]));
    await w("apps/tests/node_modules/x/app.json", appJson("eeeeeeee-0000-0000-0000-000000000000", "Also skipped"));
    await w("unlisted/app.json", appJson("dddddddd-0000-0000-0000-000000000000", "Not in workspace file"));
    return ws;
}

// ---------- apps ----------

test("discoverApps honours .code-workspace, skips .alpackages/node_modules and orders by dependency", async () => {
    const ws = await makeWorkspace();
    const apps = await discoverApps(ws);
    assert.deepEqual(apps.map((a) => a.name), ["Base App", "Extension App", "Test App"]);
    const ext = apps[1];
    assert.equal(ext.id, IDS.ext);
    assert.deepEqual(ext.dependsOn, ["Base App"]);
    assert.deepEqual(ext.dependencies.map((d) => d.inWorkspace), [true, false]);
    assert.deepEqual(apps[0].idRanges, [{ from: 50100, to: 50149 }]);
    assert.equal(apps[0].runtime, "14.0");
    assert.deepEqual(apps.errors, []);
    await rm(ws, { recursive: true, force: true });
});

test("orderByDependencies flags cycles instead of looping", () => {
    const a = { id: "a", name: "A", dependencies: [{ id: "b" }] };
    const b = { id: "b", name: "B", dependencies: [{ id: "a" }] };
    const c = { id: "c", name: "C", dependencies: [] };
    const out = orderByDependencies([a, b, c]);
    assert.deepEqual(out.map((x) => [x.name, !!x.cycle]), [["C", false], ["A", true], ["B", true]]);
});

// ---------- compiler ----------

test("parseDiagnostics extracts located and bare diagnostics, de-duplicated", () => {
    const d = parseDiagnostics(alcOutput);
    assert.equal(d.length, 5);
    assert.deepEqual(d[0], { severity: "error", code: "AL0297", file: "C:\\Work\\App\\src\\Session\\EventSession.Table.al", line: 94, column: 10, message: "The application object identifier '50999' is not valid. It must be within the allowed ranges '[50200..50299]'." });
    assert.equal(d[2].severity, "warning");
    assert.equal(d[3].column, null);
    assert.equal(d[4].file, null);
    assert.equal(d[4].code, "AL1022");
    assert.equal(hasMissingSymbols(d), true);
    assert.equal(hasMissingSymbols(d.slice(0, 3)), false);
});

test("findCompiler picks the newest AL extension across VS Code and Insiders and layout variants", async () => {
    const home = await mkdtemp(join(tmpdir(), "bc-publisher-home-"));
    const mk = async (p) => {
        await mkdir(dirname(join(home, p)), { recursive: true });
        await writeFile(join(home, p), "");
    };
    await mk(".vscode/extensions/ms-dynamics-smb.al-18.0.2732683/bin/alc.exe");
    await mk(".vscode/extensions/ms-dynamics-smb.al-29.1.100/bin/win32/alc.exe");
    await mk(".vscode-insiders/extensions/ms-dynamics-smb.al-30.0.2863738/bin/alc.exe");
    await mkdir(join(home, ".vscode-insiders/extensions/ms-dynamics-smb.al-31.0.1"), { recursive: true }); // no alc → ignored
    const c = await findCompiler({ home });
    assert.equal(c.version, "30.0.2863738");
    assert.match(c.path, /al-30\.0\.2863738[\\/]bin[\\/]alc\.exe$/);
    await rm(join(home, ".vscode-insiders"), { recursive: true });
    const c2 = await findCompiler({ home });
    assert.match(c2.path, /bin[\\/]win32[\\/]alc\.exe$/);
    await rm(home, { recursive: true, force: true });
    await assert.rejects(findCompiler({ home: join(tmpdir(), "no-such-home-xyz") }), /No AL Language extension/);
});

test("buildCompileArgs honours ruleset, analysers and package cache settings", async () => {
    const ws = await makeWorkspace();
    const app = { publisher: "Contoso", name: "Extension App", version: "1.0.0.1" };
    const appPath = join(ws, "apps", "ext");
    const { args, outFile } = await buildCompileArgs(appPath, { compiler: { analyzersDir: "C:/al/bin/Analyzers" }, app, workspaceRoot: ws });
    assert.equal(args[0], `/project:${appPath}`);
    assert.equal(args[1], `/packagecachepath:${join(appPath, ".alpackages")};${join(ws, "apps", "shared-symbols")}`);
    assert.equal(outFile, join(appPath, "Contoso_Extension App_1.0.0.1.app"));
    assert.ok(args.includes(`/ruleset:${join(appPath, "custom.ruleset.json")}`));
    assert.ok(args.includes(`/analyzer:${join("C:/al/bin/Analyzers", "Microsoft.Dynamics.Nav.CodeCop.dll")}`));
    assert.ok(args.includes(`/analyzer:${join("C:/al/bin/Analyzers", "Microsoft.Dynamics.Nav.UICop.dll")}`));
    assert.ok(args.includes(`/analyzer:${join(appPath, "analyzers", "My.dll")}`));
    await rm(ws, { recursive: true, force: true });
});

test("isAppFresh compares the .app against every source file", async () => {
    const ws = await makeWorkspace();
    const appPath = join(ws, "apps", "ext");
    const out = join(appPath, "x.app");
    assert.equal(await isAppFresh(appPath, out), false);
    await writeFile(out, "app");
    const future = new Date(Date.now() + 60e3);
    await utimes(out, future, future);
    assert.equal(await isAppFresh(appPath, out), true);
    const later = new Date(Date.now() + 120e3);
    await utimes(join(appPath, "src", "Thing.Codeunit.al"), later, later);
    assert.equal(await isAppFresh(appPath, out), false);
    await rm(ws, { recursive: true, force: true });
});

// ---------- environments ----------

const cfg = normaliseConfig({ tenants: [{ id: T, label: "Customer A" }], environments: { "container:bcdev": { agentMayPublish: true } } });

function merged(containers = [{ name: "bcdev", running: true, version: "28.4.1.0", country: "w1", apps: [{ id: IDS.ext, version: "1.0.0.0", installed: true }] }]) {
    const launch = parseLaunchJson(LAUNCH, "C:/ws/apps/ext");
    const saas = adminEnvs.value.filter((e) => e.applicationFamily === "BusinessCentral").map((e) => ({ tenant: cfg.tenants[0], name: e.name, type: e.type, applicationVersion: e.applicationVersion, countryCode: e.countryCode, status: e.status }));
    return mergeEnvironments({ launch, containers, saas, config: cfg });
}
const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e]));

test("parseLaunchJson keeps only AL launch configurations", () => {
    const l = parseLaunchJson(LAUNCH, "C:/ws");
    assert.equal(l.length, 6);
    assert.equal(l[0].schemaUpdateMode, "ForceSync");
    assert.equal(l[2].server, "http://bcdev");
});

test("mergeEnvironments combines launch.json, containers and SaaS into one de-duplicated list", () => {
    const e = byId(merged());
    assert.deepEqual(Object.keys(e).sort(), ["container:bcdev", "onprem:bc.contoso.com/bc250", `saas:${T}:dev`, `saas:${T}:production`, "saas:default:prod2", "saas:default:sandbox"].sort());

    const c = e["container:bcdev"];
    assert.deepEqual(c.source, ["BcContainerHelper", "launch.json"]);
    assert.equal(c.state, "running");
    assert.equal(c.version, "28.4.1.0");
    assert.equal(c.agentMayPublish, true);
    assert.deepEqual(c.launchNames, ["Local container"]);
    assert.equal(c.publishable.ok, true);

    const dev = e[`saas:${T}:dev`];
    assert.deepEqual(dev.source, ["Admin Center API", "launch.json"]);
    assert.equal(dev.type, "Sandbox");
    assert.equal(dev.schemaUpdateMode, "ForceSync");
    assert.equal(dev.publishable.ok, true);

    assert.equal(e[`saas:${T}:production`].isProduction, true);
    assert.match(e[`saas:${T}:production`].publishable.reason, /Production/);
    assert.equal(e["saas:default:prod2"].isProduction, true, "declared production is production even if unverified");
    assert.equal(e["saas:default:sandbox"].publishable.ok, false);
    assert.match(e["saas:default:sandbox"].publishable.reason, /no "tenant"/);
    assert.match(e["onprem:bc.contoso.com/bc250"].publishable.reason, /not supported yet/);
});

test("an unreachable tenant's error becomes the refusal reason on its launch.json targets", () => {
    const launch = parseLaunchJson(LAUNCH, "C:/ws/apps/ext");
    const list = mergeEnvironments({ launch, containers: [], saas: [], config: cfg, tenantErrors: [{ tenantId: T, message: "AADSTS50020: user not in tenant" }] });
    const dev = byId(list)[`saas:${T}:dev`];
    assert.equal(dev.publishable.ok, false);
    assert.match(dev.publishable.reason, /AADSTS50020/);
});

test("containers named in launch.json are unknown when Docker is unreachable and missing when absent", () => {
    assert.equal(byId(merged(null))["container:bcdev"].state, "unknown");
    assert.equal(byId(merged([]))["container:bcdev"].state, "missing");
    assert.equal(byId(merged(null))["container:bcdev"].publishable.ok, false);
});

test("canPublish: production never; unverified SaaS never; agent needs agentMayPublish / confirmation", () => {
    const e = byId(merged());
    for (const actor of ["user", "agent"]) {
        assert.equal(canPublish(e[`saas:${T}:production`], { actor, confirmed: true }).ok, false);
        assert.equal(canPublish(e["saas:default:prod2"], { actor, confirmed: true }).ok, false);
        assert.equal(canPublish(e["saas:default:sandbox"], { actor, confirmed: true }).ok, false);
    }
    assert.equal(canPublish(e["container:bcdev"], { actor: "agent" }).ok, true);
    assert.match(canPublish({ ...e["container:bcdev"], agentMayPublish: false }, { actor: "agent" }).reason, /agentMayPublish/);
    assert.equal(canPublish({ ...e["container:bcdev"], agentMayPublish: false }, { actor: "user" }).ok, true);
    const ask = canPublish(e[`saas:${T}:dev`], { actor: "agent" });
    assert.equal(ask.ok, false);
    assert.equal(ask.needsConfirmation, true);
    assert.equal(canPublish(e[`saas:${T}:dev`], { actor: "agent", confirmed: true }).ok, true);
    assert.equal(canPublish(e[`saas:${T}:dev`], { actor: "user" }).ok, true);
});

test("normaliseConfig accepts environments as a keyed object or a list of { id } entries", () => {
    const a = normaliseConfig({ environments: { "Container:BCDEV": { agentMayPublish: true } } });
    const b = normaliseConfig({ _comment: "x", environments: [{ id: "container:bcdev", agentMayPublish: true, _comment: "y" }] });
    assert.deepEqual(a.environments, { "container:bcdev": { agentMayPublish: true } });
    assert.deepEqual(b.environments, a.environments);
    assert.throws(() => normaliseConfig({ environments: [{ agentMayPublish: true }] }), /needs an "id"/);
    assert.throws(() => normaliseConfig({ environments: { x: { agentMayPublish: "yes" } } }), /true or false/);
});

test("container discovery output parsing handles success, errors and missing output", () => {
    const ok = parseContainerOutput(["BcContainerHelper version 6.1.5", '@@BCPUB@@[{"name":"bcdev","running":true,"version":"28.4.1.0","country":"w1","apps":[]}]']);
    assert.equal(ok[0].name, "bcdev");
    assert.deepEqual(parseContainerOutput(['@@BCPUB@@{"name":"one","running":false}']).map((c) => c.name), ["one"]);
    assert.throws(() => parseContainerOutput(["@@BCPUB@@ERR Docker engine is not running"]), /Docker engine is not running/);
    assert.throws(() => parseContainerOutput(["nothing"]), /no result/);
    assert.match(containerDiscoveryScript(["it's"]), /'it''s'/);
});

test("container publish script escapes values and chooses install vs upgrade", () => {
    const s = containerPublishScript({ containerName: "bc'dev", appFile: "C:\\a b\\x.app", app: { id: "id1", name: "O'Brien App", publisher: "Contoso", version: "1.2.3.4" }, mode: "ForceSync" });
    assert.match(s, /\$c = 'bc''dev'/);
    assert.match(s, /-appName 'O''Brien App'/);
    assert.match(s, /syncMode = 'ForceSync'/);
    assert.match(s, /\$params\.upgrade = \$true/);
    assert.match(s, /\$params\.install = \$true/);
    assert.equal(normaliseMode(undefined, { schemaUpdateMode: "ForceSync" }), "ForceSync");
    assert.equal(normaliseMode("add"), "Add");
    assert.throws(() => normaliseMode("Destroy"), /mode must be/);
});

// ---------- runs ----------

test("run store keeps the last 50 runs and refuses to overwrite unrecognised data", async () => {
    const home = await mkdtemp(join(tmpdir(), "bc-publisher-runs-"));
    const store = createRunStore(home);
    for (let i = 0; i < MAX_RUNS + 5; i++) {
        await store.add({ id: `r${i}`, kind: "publish", environmentId: i % 2 ? "container:a" : "container:b", startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ok: i !== 53 });
    }
    const all = await store.list();
    assert.equal(all.length, MAX_RUNS);
    assert.equal(all[0].id, "r54");
    assert.equal((await store.last("container:a")).id, "r53");
    assert.equal((await store.last("container:a")).ok, false);

    await writeFile(store.file, '{"something":"else"}');
    await assert.rejects(store.add({ id: "x", startedAt: "2027-01-01", ok: true }), /unrecognised format/);
    assert.equal(await readFile(store.file, "utf8"), '{"something":"else"}');
    await rm(home, { recursive: true, force: true });
});

// ---------- prompt ----------

test("buildErrorPrompt includes app, target, command, diagnostics and the publisher tool instruction", () => {
    const run = {
        kind: "publish", appName: "Extension App", appVersion: "1.0.0.1", appPath: "C:/ws/apps/ext", environmentId: "container:bcdev", environmentLabel: "bcdev",
        phase: "compiling", command: "alc.exe /project:C:/ws/apps/ext", diagnostics: parseDiagnostics(alcOutput), missingSymbols: true,
    };
    const p = buildErrorPrompt(run);
    assert.match(p, /^Publishing "Extension App" 1\.0\.0\.1 to bcdev \(environmentId "container:bcdev"\) failed during compiling\./);
    assert.match(p, /Command: alc\.exe/);
    assert.match(p, /EventSession\.Table\.al\(94,10\): error AL0297/);
    assert.doesNotMatch(p, /warning AL0432/);
    assert.match(p, /Symbols are missing/);
    assert.match(p, /publisher_publish with appPath "C:\/ws\/apps\/ext" and environmentId "container:bcdev"/);
    assert.match(buildErrorPrompt({ ...run, kind: "compile", environmentId: null }), /publisher_compile/);
});

// ---------- end to end with fakes ----------

async function fakePublisher(ws, { agentMayPublish = true } = {}) {
    const home = await mkdtemp(join(tmpdir(), "bc-publisher-home-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ tenants: [{ id: T, label: "Customer A" }], environments: [{ id: "container:bcdev", agentMayPublish }] }));
    const calls = { pwsh: [], fetch: [] };
    const runPwsh = async (script, { onOutput } = {}) => {
        calls.pwsh.push(script);
        const lines = script.includes("Get-BcContainers")
            ? [`@@BCPUB@@[{"name":"bcdev","running":true,"version":"28.4.1.0","country":"w1","apps":[]}]`]
            : ["Publishing app", "Synchronizing", "@@BCPUB@@OK"];
        for (const l of lines) onOutput?.(l, "stdout");
        return { code: 0, cancelled: false, lines };
    };
    const fetch = async (url, init = {}) => {
        calls.fetch.push({ url, init });
        if (url.includes("/admin/")) return new Response(JSON.stringify(adminEnvs), { status: 200 });
        if (url.includes("/dev/apps")) return new Response("", { status: 200 });
        return new Response("{}", { status: 404 });
    };
    const runAz = async (args) => JSON.stringify({ accessToken: `tok-${args[args.indexOf("--tenant") + 1]}`, expires_on: Math.floor(Date.now() / 1000) + 3600 });
    const findCompiler = async () => ({ path: process.execPath, prefixArgs: [FAKE_ALC], version: "99.0.0", analyzersDir: "X" });
    return { publisher: createPublisher({ workspaceRoot: ws, home, fetch, runAz, runPwsh, findCompiler }), calls, home };
}

test("publishApp compiles then publishes to a container, streaming output and recording the run", async () => {
    const ws = await makeWorkspace();
    const { publisher, calls, home } = await fakePublisher(ws);
    const out = [];
    const phases = [];
    const run = await publisher.publishApp(join(ws, "apps", "base"), "container:bcdev", { onOutput: (l) => out.push(l), onPhase: (p) => phases.push(p), actor: "agent" });
    assert.equal(run.ok, true, run.error);
    assert.deepEqual(phases, ["compiling", "publishing"]);
    assert.equal(run.mode, "Add");
    assert.ok(out.some((l) => l.startsWith("> alc.exe")));
    assert.ok(out.includes("Synchronizing"));
    const script = calls.pwsh.find((s) => s.includes("Publish-BcContainerApp"));
    assert.match(script, /\$c = 'bcdev'/);
    assert.match(script, /Contoso_Base App_1\.0\.0\.1\.app/);
    assert.equal((await publisher.getLastRun("container:bcdev")).id, run.id);
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
});

test("publishApp posts the .app to the SaaS dev endpoint with the mapped schema mode", async () => {
    const ws = await makeWorkspace();
    const { publisher, calls, home } = await fakePublisher(ws);
    const run = await publisher.publishApp(join(ws, "apps", "base"), `saas:${T}:dev`, { mode: "ForceSync" });
    assert.equal(run.ok, true, run.error);
    const post = calls.fetch.find((c) => c.url.includes("/dev/apps"));
    assert.equal(post.url, `https://api.businesscentral.dynamics.com/v2.0/${T}/dev/dev/apps?SchemaUpdateMode=forcesync`);
    assert.equal(post.init.method, "POST");
    assert.equal(post.init.headers.Authorization, `Bearer tok-${T}`);
    assert.ok(post.init.body instanceof FormData);
    const [[name, file]] = [...post.init.body.entries()];
    assert.equal(name, "Contoso_Base App_1.0.0.1.app");
    assert.equal(await file.text(), "fake app");
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
});

test("publishApp refuses production, unknown apps, agent SaaS without confirmation and agent containers without opt-in", async () => {
    const ws = await makeWorkspace();
    const { publisher, calls, home } = await fakePublisher(ws, { agentMayPublish: false });
    const base = join(ws, "apps", "base");
    await assert.rejects(publisher.publishApp(base, `saas:${T}:production`), (e) => e instanceof PublishRefused && /Production/.test(e.message));
    await assert.rejects(publisher.publishApp(base, "saas:default:prod2", { actor: "agent", confirmed: true }), PublishRefused);
    await assert.rejects(publisher.publishApp(base, `saas:${T}:dev`, { actor: "agent" }), (e) => e.needsConfirmation === true);
    await assert.rejects(publisher.publishApp(base, "container:bcdev", { actor: "agent" }), /agentMayPublish/);
    await assert.rejects(publisher.publishApp(join(ws, "unlisted"), "container:bcdev"), /not an AL app in this workspace/);
    await assert.rejects(publisher.publishApp(base, "container:nope"), /Unknown environment/);
    assert.equal(calls.fetch.filter((c) => c.url.includes("/dev/apps")).length, 0);
    assert.equal(calls.pwsh.filter((s) => s.includes("Publish-BcContainerApp")).length, 0);
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
});

test("a broken app stops at compile with parsed diagnostics and an agent prompt", async () => {
    const ws = await makeWorkspace();
    const { publisher, calls, home } = await fakePublisher(ws);
    const ext = join(ws, "apps", "ext");
    await writeFile(join(ext, "BROKEN"), "");
    const run = await publisher.publishApp(ext, "container:bcdev");
    assert.equal(run.ok, false);
    assert.equal(run.phase, "compiling");
    assert.deepEqual(run.diagnostics.map((d) => [d.code, d.line, d.column]), [["AL0118", 7, 9]]);
    assert.equal(calls.pwsh.filter((s) => s.includes("Publish-BcContainerApp")).length, 0);
    const prompt = publisher.buildErrorPrompt(run);
    assert.match(prompt, /Thing\.Codeunit\.al\(7,9\): error AL0118/);
    assert.match(prompt, /publisher_publish/);

    const compileRun = await publisher.compileApp(ext);
    assert.equal(compileRun.kind, "compile");
    assert.equal(compileRun.ok, false);
    await rm(join(ext, "BROKEN"));
    assert.equal((await publisher.compileApp(ext)).ok, true);
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
});

test("signIn runs az login for a configured tenant and restores az's previous default account", async () => {
    const home = await mkdtemp(join(tmpdir(), "bc-publisher-signin-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ tenants: [{ id: T, label: "Customer A" }] }));
    const calls = [];
    const runAz = async (args) => {
        calls.push(["az", ...args]);
        if (args[0] === "account" && args[1] === "show") return JSON.stringify({ id: "home-sub", tenantId: "home-tenant", user: { name: "me@home" } });
        return "";
    };
    const out = [];
    const runAzStreamed = async (args, { onOutput }) => {
        calls.push(["az-streamed", ...args]);
        onOutput?.("A web browser has been opened.", "stdout");
        return { code: 0, cancelled: false, lines: ["A web browser has been opened."] };
    };
    const p = createPublisher({ workspaceRoot: home, home, runAz, runAzStreamed, runPwsh: async () => ({ code: 0, lines: [] }) });
    const r = await p.signIn(T.toUpperCase(), { onOutput: (l) => out.push(l) });
    assert.equal(r.ok, true);
    assert.deepEqual(calls.find((c) => c[0] === "az-streamed"), ["az-streamed", "login", "--tenant", T, "--allow-no-subscriptions", "--scope", "https://api.businesscentral.dynamics.com/.default", "-o", "none"]);
    assert.deepEqual(calls.at(-1), ["az", "account", "set", "--subscription", "home-sub"], "previous default account restored last");
    assert.ok(out.some((l) => /Restored az's default account \(me@home\)/.test(l)));
    await assert.rejects(p.signIn("22222222-2222-2222-2222-222222222222"), /not listed/);

    const cancelled = createPublisher({ workspaceRoot: home, home, runAz, runAzStreamed: async () => ({ code: null, cancelled: true, lines: [] }) });
    assert.deepEqual(await cancelled.signIn(T), { ok: false, cancelled: true, tail: [] });
    await rm(home, { recursive: true, force: true });
});
