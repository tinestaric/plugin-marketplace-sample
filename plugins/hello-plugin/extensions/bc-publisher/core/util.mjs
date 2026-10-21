import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Strip // and /* *\/ comments and trailing commas from JSONC text, respecting strings. */
export function stripJsonComments(text) {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const n = text[i + 1];
        if (inString) {
            out += c;
            if (c === "\\") {
                out += n ?? "";
                i++;
            } else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
        } else if (c === "/" && n === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && n === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i++;
        } else out += c;
    }
    return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text) {
    return JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
}

export async function readJsonc(file) {
    return parseJsonc(await readFile(file, "utf8"));
}

/** Write a file atomically: unique temp file in the same directory, then rename over the target. */
export async function atomicWrite(file, content) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${Date.now()}-${randomBytes(4).toString("hex")}.tmp`);
    try {
        await writeFile(tmp, content, "utf8");
        // Windows: AV scanners/indexers briefly lock a just-written target, so retry transient rename failures.
        for (let attempt = 0; ; attempt++) {
            try {
                await rename(tmp, file);
                break;
            } catch (e) {
                if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
                await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
            }
        }
    } catch (e) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
    }
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s) => s.replace(ANSI, "");

export const errMsg = (e) => (e && e.message ? e.message : String(e));
