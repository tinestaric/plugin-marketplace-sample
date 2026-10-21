import { spawn, execFile } from "node:child_process";
import { stripAnsi } from "./util.mjs";

/** Kill a process and its children. Windows needs taskkill /T for the tree (pwsh → docker → …). */
export function killTree(child) {
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else child.kill("SIGTERM");
}

/**
 * Spawn a process and stream its output line by line (ANSI stripped).
 * Resolves { code, cancelled, lines } — never rejects for a non-zero exit.
 */
export function spawnStreamed(cmd, args, { onOutput = () => {}, signal, cwd, timeoutMs = 0, keepLines = 4000 } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return resolve({ code: null, cancelled: true, lines: [] });
        let child;
        try {
            child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            return reject(e);
        }
        const lines = [];
        let cancelled = false;
        const push = (stream) => {
            let buf = "";
            return (chunk) => {
                buf += chunk.toString("utf8");
                const parts = buf.split(/\r?\n/);
                buf = parts.pop();
                for (const raw of parts) emit(raw, stream);
            };
        };
        const emit = (raw, stream) => {
            const line = stripAnsi(raw).replace(/\s+$/, "");
            lines.push(line);
            if (lines.length > keepLines) lines.shift();
            try {
                onOutput(line, stream);
            } catch {
                /* listener errors must not kill the process */
            }
        };
        child.stdout.on("data", push("stdout"));
        child.stderr.on("data", push("stderr"));
        const onAbort = () => {
            cancelled = true;
            killTree(child);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = timeoutMs ? setTimeout(() => (emit(`Timed out after ${Math.round(timeoutMs / 1000)}s`, "stderr"), onAbort()), timeoutMs) : null;
        child.on("error", (e) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve({ code, cancelled, lines });
        });
    });
}

/** PowerShell single-quoted literal. */
export const psq = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** Run a PowerShell 7 script via -EncodedCommand (no quoting pitfalls). */
export function runPwsh(script, opts = {}) {
    const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, "utf16le").toString("base64");
    return spawnStreamed("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], opts);
}

/** az CLI (a .cmd shim on Windows) → stdout. */
export function runAz(args, { timeoutMs = 60000 } = {}) {
    const [file, argv] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "az", ...args]] : ["az", args];
    return new Promise((resolve, reject) => {
        execFile(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message || "az failed").toString().trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ")));
            else resolve(stdout.toString());
        });
    });
}
