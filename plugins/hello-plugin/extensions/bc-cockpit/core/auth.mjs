import { execFile } from "node:child_process";

export const AZDO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
export const LOGIN_COMMAND = "az login";

export class AuthError extends Error {
    constructor(message, details = []) {
        super(message);
        this.code = "not_signed_in";
        this.command = LOGIN_COMMAND;
        this.details = details;
    }
}

/** Run a command and resolve stdout. On Windows az is a .cmd shim, so route through cmd.exe. */
export function runCommand(cmd, args, { timeoutMs = 30000 } = {}) {
    const [file, argv] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", cmd, ...args]] : [cmd, args];
    return new Promise((resolve, reject) => {
        execFile(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const msg = (stderr || err.message || "").toString().trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
                reject(new Error(msg || `${cmd} failed`));
            } else resolve(stdout.toString());
        });
    });
}

/**
 * Token provider: az CLI bearer token first, AZDO_PAT (Basic, empty user) second.
 * Tokens live only in memory and are refreshed shortly before they expire.
 */
export function createAuth({ run = runCommand, env = process.env, now = () => Date.now() } = {}) {
    let cached = null;
    let inflight = null;

    async function acquire() {
        const problems = [];
        try {
            const out = await run("az", ["account", "get-access-token", "--resource", AZDO_RESOURCE, "-o", "json"]);
            const j = JSON.parse(out);
            if (!j.accessToken) throw new Error("az returned no accessToken");
            const exp = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn);
            return { header: `Bearer ${j.accessToken}`, method: "az", expiresAt: Number.isFinite(exp) ? exp : now() + 30 * 60e3 };
        } catch (e) {
            problems.push(`az: ${e.message}`);
        }
        const pat = env.AZDO_PAT;
        if (pat && pat.trim()) {
            return { header: `Basic ${Buffer.from(`:${pat.trim()}`).toString("base64")}`, method: "pat", expiresAt: Infinity };
        }
        problems.push("AZDO_PAT: not set");
        throw new AuthError("Not signed in to Azure DevOps.", problems);
    }

    return {
        async get() {
            if (cached && cached.expiresAt - now() > 5 * 60e3) return cached;
            inflight ??= acquire().finally(() => (inflight = null));
            cached = await inflight;
            return cached;
        },
        invalidate() {
            cached = null;
        },
        /** Public, non-secret description of the current auth state. */
        describe() {
            return cached ? { ok: true, method: cached.method } : { ok: false };
        },
    };
}
