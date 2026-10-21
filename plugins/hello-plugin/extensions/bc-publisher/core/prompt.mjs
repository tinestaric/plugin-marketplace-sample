const MAX_DIAGS = 40;

const fmtDiag = (d) => `- ${d.file ? `${d.file}(${d.line ?? "?"},${d.column ?? "?"}): ` : ""}${d.severity} ${d.code}: ${d.message}`;

/** Short, specific instruction for the agent after a failed compile or publish. Code has already trimmed the output. */
export function buildErrorPrompt(run) {
    if (!run || typeof run !== "object") throw new TypeError("buildErrorPrompt needs a run record");
    const errors = (run.diagnostics ?? []).filter((d) => d.severity === "error");
    const shown = (errors.length ? errors : run.diagnostics ?? []).slice(0, MAX_DIAGS);
    const target = run.environmentId ? `${run.environmentLabel ?? run.environmentId} (environmentId "${run.environmentId}")` : null;
    const what = run.kind === "publish" ? `Publishing "${run.appName}" ${run.appVersion} to ${target}` : `Compiling "${run.appName}" ${run.appVersion}`;
    const lines = [
        `${what} failed during ${run.phase ?? run.kind}.`,
        `App folder: ${run.appPath}`,
        `Command: ${run.command ?? "(none)"}`,
        "",
    ];
    if (shown.length) {
        lines.push(`Diagnostics (${errors.length} error${errors.length === 1 ? "" : "s"}${errors.length > shown.length ? `, first ${shown.length} shown` : ""}):`, ...shown.map(fmtDiag));
        if (run.missingSymbols) lines.push("", "Symbols are missing from the package cache; they must be downloaded before the app can compile.");
    } else {
        lines.push("Output (last lines):", "```", ...(run.tail ?? []).slice(-25), "```");
        if (run.error) lines.push(`Error: ${run.error}`);
    }
    lines.push("");
    if (run.kind === "publish" && run.environmentId) {
        lines.push(`Fix the code, then publish again using the publisher tool: publisher_publish with appPath "${run.appPath}" and environmentId "${run.environmentId}". Do not publish any other way. Report the result.`);
    } else {
        lines.push(`Fix the code, then verify with the publisher tool: publisher_compile with appPath "${run.appPath}". Report the result.`);
    }
    return lines.join("\n");
}
