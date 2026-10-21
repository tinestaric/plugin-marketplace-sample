import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./util.mjs";

const FORMAT = "bc-publisher-runs";
const VERSION = 1;
export const MAX_RUNS = 50;

export class StorageError extends Error {
    constructor(message) {
        super(message);
        this.code = "storage_error";
    }
}

const validRun = (r) => r && typeof r.id === "string" && typeof r.startedAt === "string" && typeof r.ok === "boolean";

/** Run history in ~/.bc-publisher/runs.json. Validated on every read; never overwrites data it does not recognise. */
export function createRunStore(home) {
    const file = join(home, "runs.json");
    let chain = Promise.resolve();

    async function read() {
        let text;
        try {
            text = await readFile(file, "utf8");
        } catch (e) {
            if (e.code === "ENOENT") return [];
            throw new StorageError(`Cannot read ${file}: ${e.message}`);
        }
        let j;
        try {
            j = JSON.parse(text);
        } catch {
            throw new StorageError(`${file} is not valid JSON; move it aside to start a new history.`);
        }
        if (j?.format !== FORMAT || j.version !== VERSION || !Array.isArray(j.runs)) {
            throw new StorageError(`${file} has an unrecognised format; move it aside to start a new history.`);
        }
        return j.runs.filter(validRun);
    }

    return {
        file,
        list: read,
        /** Append a run (re-reads first so concurrent sessions do not drop each other's runs). */
        add(run) {
            const p = chain.catch(() => {}).then(async () => {
                const runs = await read();
                const next = [run, ...runs.filter((r) => r.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS);
                await atomicWrite(file, JSON.stringify({ format: FORMAT, version: VERSION, runs: next }, null, 1));
            });
            chain = p;
            return p;
        },
        async last(environmentId) {
            return (await read()).find((r) => r.kind === "publish" && r.environmentId === environmentId) ?? null;
        },
    };
}
