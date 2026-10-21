import { API, projUrl } from "./azdo.mjs";
import { errMsg, mapLimit, stripAnsi } from "./util.mjs";

export const MAX_TRIMMED_BYTES = 8 * 1024;
const TAIL_LINES = 40;
const MAX_FAILED_LOGS = 6;

const TIMESTAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const AL_DIAG = /\b(error|warning) (AL\d{4})\b/i;
const CODEUNIT = /^\s*Codeunit\s+(\d+)\s+(.+?)\s+(Failure|Success|Skipped)\b/i;
const TESTFN = /^\s*Testfunction\s+(.+?)\s+(Failure|Success|Skipped)\b/i;
const indentOf = (s) => s.match(/^\s*/)[0].length;
const bytes = (s) => Buffer.byteLength(s, "utf8");

export function cleanLines(text) {
    return String(text ?? "")
        .split(/\r?\n/)
        .map((l) => stripAnsi(l.replace(TIMESTAMP, "")).replace(/\s+$/, ""));
}

/** AL compiler diagnostics, de-duplicated, errors before warnings. */
export function extractAlDiagnostics(lines) {
    const seen = new Set();
    const errors = [];
    const warnings = [];
    for (const raw of lines) {
        const m = raw.match(AL_DIAG);
        if (!m) continue;
        const line = raw.replace(/^##\[(error|warning)\]/, "").replace(/^##vso\[[^\]]*\]/, "").trim();
        const key = line.replace(/^.*?(?=[A-Za-z]:\\|\/|\w+\.al\b)/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        (m[1].toLowerCase() === "error" ? errors : warnings).push(line);
    }
    return { errors, warnings };
}

/** AL test runner failure blocks: codeunit, method, error message and call stack. */
export function extractTestFailures(lines) {
    const blocks = [];
    let codeunit = null;
    for (let i = 0; i < lines.length; i++) {
        const cu = lines[i].match(CODEUNIT);
        if (cu) {
            codeunit = `Codeunit ${cu[1]} ${cu[2]}`;
            continue;
        }
        const fn = lines[i].match(TESTFN);
        if (!fn || fn[2].toLowerCase() !== "failure") continue;
        const base = indentOf(lines[i]);
        const body = [];
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > base)) {
            if (lines[j].trim()) body.push(lines[j].trim());
            j++;
        }
        blocks.push({ codeunit, method: fn[1], lines: body.slice(0, 25) });
        i = j - 1;
    }
    return blocks;
}

const formatTests = (blocks) =>
    blocks.map((b) => [`${b.codeunit ?? "Codeunit ?"} :: ${b.method}`, ...b.lines.map((l) => `  ${l}`)].join("\n")).join("\n");

// Azure Pipelines task banner and grouping noise.
const NOISE = /^(?:=+|(?:Task|Description|Version|Author|Help)\s+:.*|Generating script\.|=+ Starting Command Output =+|##\[(?:section|command|group|endgroup)\].*)$/;
const GENERIC_EXIT = /^(PowerShell|Bash|Cmd) exited with code '\d+'\.$|^Process completed with exit code \d+\.$/;

/** Trim one failed step's log to what matters. `issues` are the error messages the timeline reported for the step. */
export function trimStepLog(text, { includeWarnings = true, issues = [] } = {}) {
    const lines = cleanLines(text);
    const diag = extractAlDiagnostics(lines);
    const tests = extractTestFailures(lines);
    const reported = [...new Set(issues.map((i) => i.trim()).filter((i) => i && !GENERIC_EXIT.test(i)))].filter(
        (i) => !diag.errors.some((e) => e.includes(i) || i.includes(e)),
    );
    const parts = [];
    if (reported.length) parts.push(reported.map((i) => `reported: ${i}`).join("\n"));
    if (diag.errors.length) parts.push(diag.errors.join("\n"));
    if (tests.length) parts.push(formatTests(tests));
    if (includeWarnings && diag.warnings.length) parts.push(diag.warnings.join("\n"));
    if (!diag.errors.length && !tests.length) {
        const tail = lines.filter((l) => l.trim() && !NOISE.test(l.trim())).slice(-TAIL_LINES);
        parts.push(tail.join("\n"));
    }
    return { text: parts.filter(Boolean).join("\n"), alErrors: diag.errors.length, alWarnings: diag.warnings.length, testFailures: tests.length };
}

/** Combine trimmed step logs and cap at ~8 KB, dropping warnings before truncating. */
export function combineTrimmed(steps, maxBytes = MAX_TRIMMED_BYTES) {
    const render = (withWarnings) =>
        steps.map((s) => `### ${s.name}\n${trimStepLog(s.log, { includeWarnings: withWarnings, issues: s.issues ?? [] }).text || "(no log output)"}`).join("\n\n");
    let out = render(true);
    if (bytes(out) > maxBytes) out = render(false);
    if (bytes(out) > maxBytes) {
        const suffix = "\n… (truncated)";
        let buf = Buffer.from(out, "utf8").subarray(0, maxBytes - bytes(suffix)).toString("utf8");
        buf = buf.replace(/\uFFFD$/, "");
        out = buf.slice(0, buf.lastIndexOf("\n") > 0 ? buf.lastIndexOf("\n") : buf.length) + suffix;
    }
    return out;
}

/** Failed task records from a build timeline, in execution order. */
export function selectFailedRecords(timeline) {
    const records = timeline?.records ?? [];
    const order = (r) => [r.startTime ?? "", r.order ?? 0];
    const failed = records.filter((r) => r.result === "failed" && r.log?.id != null);
    const tasks = failed.filter((r) => r.type === "Task");
    return (tasks.length ? tasks : failed).sort((a, b) => {
        const [sa, oa] = order(a);
        const [sb, ob] = order(b);
        return sa.localeCompare(sb) || oa - ob;
    });
}

/** Deterministically prepare everything an agent needs to fix a failed build. */
export async function getFailureDetails(client, { org, project, buildId }, { resolveRepo }) {
    const base = projUrl(org, project);
    const build = await client.get(`${base}/_apis/build/builds/${buildId}?${API}`);
    const timeline = await client.get(`${base}/_apis/build/builds/${buildId}/timeline?${API}`).catch(() => ({ records: [] }));
    const failed = selectFailedRecords(timeline).slice(0, MAX_FAILED_LOGS);
    const steps = await mapLimit(failed, 3, async (r) => {
        let log = "";
        try {
            log = await client.text(`${base}/_apis/build/builds/${buildId}/logs/${r.log.id}?${API}`);
        } catch (e) {
            log = `(could not fetch log: ${errMsg(e)})`;
        }
        const issues = (r.issues ?? []).filter((i) => i.type === "error").map((i) => i.message);
        if (!log.trim() && issues.length) log = issues.join("\n");
        return { name: r.name, log, issues };
    });

    let remoteUrl = null;
    const repo = build.repository ?? {};
    if (repo.type === "TfsGit") {
        const r = await client.get(`${base}/_apis/git/repositories/${repo.id}?${API}`).catch(() => null);
        remoteUrl = r?.remoteUrl ?? null;
    } else if (repo.type === "GitHub") remoteUrl = `https://github.com/${repo.id}`;
    else remoteUrl = repo.url ?? null;

    const ti = build.triggerInfo ?? {};
    let branch = (ti["pr.sourceBranch"] || build.sourceBranch || "").replace(/^refs\/heads\//, "");
    let commit = ti["pr.sourceSha"] || build.sourceVersion || null;
    // PR validation builds run on a merge ref; the agent needs the PR's real source branch and head commit.
    const prMerge = /^refs\/pull\/(\d+)\/merge$/.exec(branch);
    if (prMerge && repo.type === "TfsGit") {
        const pr = await client.get(`${base}/_apis/git/repositories/${repo.id}/pullrequests/${prMerge[1]}?${API}`).catch(() => null);
        if (pr?.sourceRefName) branch = pr.sourceRefName.replace(/^refs\/heads\//, "");
        if (pr?.lastMergeSourceCommit?.commitId) commit = pr.lastMergeSourceCommit.commitId;
    }
    const trimmedLog = steps.length ? combineTrimmed(steps) : "(no failed steps with logs were found in the build timeline)";
    return {
        org,
        project,
        repo: repo.name ?? null,
        branch,
        buildId: build.id,
        buildNumber: build.buildNumber,
        definition: build.definition?.name ?? null,
        buildUrl: build._links?.web?.href ?? `${base}/_build/results?buildId=${build.id}`,
        result: build.result ?? null,
        failedSteps: steps.map((s) => ({ name: s.name, issues: s.issues.slice(0, 5) })),
        trimmedLog,
        localPath: remoteUrl ? await resolveRepo(remoteUrl).catch(() => null) : null,
        remoteUrl,
        commit,
        prId: prMerge ? Number(prMerge[1]) : null,
    };
}

/** Short, specific hand-off instruction for the agent. */
export function buildFixPrompt(f) {
    if (!f || typeof f !== "object") throw new TypeError("buildFixPrompt needs the result of getFailureDetails");
    const commit = f.commit ? f.commit.slice(0, 10) : "unknown";
    const steps = f.failedSteps?.length ? f.failedSteps.map((s) => `- ${s.name}`).join("\n") : "- (none recorded)";
    const where = f.localPath
        ? `The local clone is at ${f.localPath}.`
        : `No local clone was found for ${f.remoteUrl ?? "this repository"}; clone it first.`;
    return [
        `The pipeline "${f.definition ?? "unknown"}" failed on branch ${f.branch || "unknown"} at commit ${commit}${f.prId ? ` (validation build for PR ${f.prId})` : ""}.`,
        `Build ${f.buildNumber ?? f.buildId}: ${f.buildUrl} (${f.org}/${f.project}${f.repo ? `, repo ${f.repo}` : ""}).`,
        "",
        "Failing steps:",
        steps,
        "",
        "Trimmed errors:",
        "```",
        f.trimmedLog,
        "```",
        "",
        `${where} Check out the branch, reproduce if possible, fix it, and summarise what you changed. Do not push.`,
    ].join("\n");
}
