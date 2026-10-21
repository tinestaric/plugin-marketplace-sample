import { API, projUrl } from "./azdo.mjs";

const stripRef = (ref) => (ref || "").replace(/^refs\/heads\//, "");

/** Deterministically gather what an agent needs to resolve a PR's merge conflicts. */
export async function getConflictDetails(client, { org, project, repoId, prId }, { resolveRepo }) {
    const base = projUrl(org, project);
    const pr = await client.get(`${base}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullrequests/${prId}?${API}`);
    const conflicts = await client
        .get(`${base}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullRequests/${prId}/conflicts?$top=100&${API}`)
        .then((r) => r.value ?? [])
        .catch(() => []);
    const repo = await client.get(`${base}/_apis/git/repositories/${encodeURIComponent(repoId)}?${API}`).catch(() => null);
    const remoteUrl = repo?.remoteUrl ?? null;
    return {
        org,
        project,
        repo: pr.repository?.name ?? repo?.name ?? null,
        prId: pr.pullRequestId,
        title: pr.title,
        url: `${repo?.webUrl ?? `${base}/_git/${encodeURIComponent(pr.repository?.name ?? "")}`}/pullrequest/${pr.pullRequestId}`,
        sourceBranch: stripRef(pr.sourceRefName),
        targetBranch: stripRef(pr.targetRefName),
        mergeStatus: pr.mergeStatus ?? null,
        sourceCommit: pr.lastMergeSourceCommit?.commitId ?? null,
        targetCommit: pr.lastMergeTargetCommit?.commitId ?? null,
        files: [...new Set(conflicts.map((c) => c.conflictPath ?? c.sourcePath ?? c.targetPath).filter(Boolean))].map((p) => p.replace(/^\//, "")),
        remoteUrl,
        localPath: remoteUrl ? await resolveRepo(remoteUrl).catch(() => null) : null,
    };
}

/** Short, specific instruction for resolving a PR merge conflict. */
export function buildConflictPrompt(c) {
    if (!c || typeof c !== "object") throw new TypeError("buildConflictPrompt needs the result of getConflictDetails");
    const files = c.files?.length ? c.files.map((f) => `- ${f}`).join("\n") : "- (Azure DevOps did not list the files; run the merge to see them)";
    const where = c.localPath ? `The local clone is at ${c.localPath}.` : `No local clone was found for ${c.remoteUrl ?? "this repository"}; clone it first.`;
    return [
        `Pull request !${c.prId} "${c.title}" (${c.org}/${c.project}, repo ${c.repo}) cannot be merged: ${c.sourceBranch} has merge conflicts with ${c.targetBranch}.`,
        `PR: ${c.url}`,
        "",
        "Conflicting files:",
        files,
        "",
        `${where} Fetch origin, check out ${c.sourceBranch}, merge origin/${c.targetBranch} into it, and resolve the conflicts so both sides' intent is preserved (read the commits on each side for context). Make sure the result still compiles, commit the merge, and summarise how you resolved each file. Do not push.`,
    ].join("\n");
}
