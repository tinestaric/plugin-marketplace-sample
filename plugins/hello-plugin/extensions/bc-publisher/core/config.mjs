import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, parseJsonc } from "./util.mjs";

export const defaultHome = () => join(homedir(), ".bc-publisher");

export class ConfigError extends Error {
    constructor(message, file) {
        super(message);
        this.code = "config_invalid";
        this.file = file;
    }
}

export function normaliseConfig(raw, file = "config.json") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("Config must be a JSON object.", file);
    const tenants = raw.tenants ?? [];
    if (!Array.isArray(tenants)) throw new ConfigError('"tenants" must be an array.', file);
    const norm = tenants.map((t, i) => {
        if (!t || typeof t.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(t.id)) throw new ConfigError(`tenants[${i}].id must be a tenant GUID or domain.`, file);
        return { id: t.id.toLowerCase(), label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : t.id };
    });
    const envs = raw.environments ?? {};
    if (typeof envs !== "object") throw new ConfigError('"environments" must be an object keyed by environment id (or a list of { "id": … } entries).', file);
    const entries = Array.isArray(envs) ? envs.map((v, i) => [v?.id, v, i]) : Object.entries(envs).map(([id, v]) => [id, v, id]);
    const environments = {};
    for (const [id, v, where] of entries) {
        if (typeof id !== "string" || !id.trim()) throw new ConfigError(`environments[${JSON.stringify(where)}] needs an "id".`, file);
        if (!v || typeof v !== "object") throw new ConfigError(`environments["${id}"] must be an object.`, file);
        if (v.agentMayPublish !== undefined && typeof v.agentMayPublish !== "boolean") throw new ConfigError(`environments["${id}"].agentMayPublish must be true or false.`, file);
        environments[id.toLowerCase()] = { agentMayPublish: v.agentMayPublish === true };
    }
    if (raw.alcPath != null && typeof raw.alcPath !== "string") throw new ConfigError('"alcPath" must be a path or null.', file);
    return { tenants: norm, environments, alcPath: raw.alcPath || null };
}

function template(tenants) {
    return `// BC Publisher configuration. Machine-specific; never put secrets here.
// SaaS tokens come from \`az login\`; containers use BcContainerHelper in PowerShell 7.
//
// "tenants": Entra tenants whose Business Central environments are listed via the BC Admin Center API.
// "environments": per-target settings keyed by the environment id shown on each card, e.g.
//     "container:bcdev": { "agentMayPublish": true }   // let the agent publish to this container without asking
// "alcPath": optional explicit path to alc.exe (default: newest AL Language extension).
{
  "tenants": ${JSON.stringify(tenants, null, 2).replace(/\n/g, "\n  ")},
  "environments": {},
  "alcPath": null
}
`;
}

export async function loadConfig({ home = defaultHome(), discoverTenant } = {}) {
    const file = join(home, "config.json");
    let created = false;
    if (!existsSync(file)) {
        let tenants = [];
        if (discoverTenant) {
            try {
                const t = await discoverTenant();
                if (t) tenants = [t];
            } catch {
                tenants = [];
            }
        }
        await atomicWrite(file, template(tenants));
        created = true;
    }
    let raw;
    try {
        raw = parseJsonc(await readFile(file, "utf8"));
    } catch (e) {
        throw new ConfigError(`Could not parse ${file}: ${e.message}`, file);
    }
    return { ...normaliseConfig(raw, file), file, created };
}
