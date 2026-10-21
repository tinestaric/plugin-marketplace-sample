import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, parseJsonc } from "./util.mjs";

export const defaultHome = () => join(homedir(), ".bc-cockpit");

export const DEFAULTS = Object.freeze({ organisations: [], repoRoots: [], refreshMinutes: 3, sprintOnly: true });

export class ConfigError extends Error {
    constructor(message, file) {
        super(message);
        this.code = "config_invalid";
        this.file = file;
    }
}

/** Validate and normalise a parsed config object. Throws ConfigError on bad shape. */
export function normaliseConfig(raw, file = "config.json") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("Config must be a JSON object.", file);
    const orgs = raw.organisations ?? [];
    if (!Array.isArray(orgs)) throw new ConfigError('"organisations" must be an array.', file);
    const organisations = orgs.map((o, i) => {
        if (!o || typeof o.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.name)) {
            throw new ConfigError(`organisations[${i}].name must be an Azure DevOps organisation name.`, file);
        }
        const p = o.projects ?? "*";
        if (p !== "*" && !(Array.isArray(p) && p.every((x) => typeof x === "string" && x.trim()))) {
            throw new ConfigError(`organisations[${i}].projects must be "*" or a list of project names.`, file);
        }
        return { name: o.name, projects: p === "*" ? "*" : p.map((x) => x.trim()) };
    });
    const repoRoots = raw.repoRoots ?? [];
    if (!Array.isArray(repoRoots) || !repoRoots.every((r) => typeof r === "string")) {
        throw new ConfigError('"repoRoots" must be a list of folder paths.', file);
    }
    const refreshMinutes = raw.refreshMinutes ?? DEFAULTS.refreshMinutes;
    if (typeof refreshMinutes !== "number" || !(refreshMinutes >= 0.5 && refreshMinutes <= 240)) {
        throw new ConfigError('"refreshMinutes" must be a number between 0.5 and 240.', file);
    }
    const sprintOnly = raw.sprintOnly ?? true;
    if (typeof sprintOnly !== "boolean") throw new ConfigError('"sprintOnly" must be true or false.', file);
    return { organisations, repoRoots, refreshMinutes, sprintOnly };
}

function template({ organisations, repoRoots }) {
    const orgLines = organisations.length
        ? organisations.map((o) => `    { "name": ${JSON.stringify(o.name)}, "projects": "*" }`).join(",\n")
        : "";
    return `// BC Cockpit configuration. Machine-specific; never put secrets here.
// Auth comes from \`az login\` (or the AZDO_PAT environment variable as a fallback).
//
// Example:
//   "organisations": [
//     { "name": "companial", "projects": "*" },
//     { "name": "customer-org", "projects": ["CustomerA-BC", "CustomerB-BC"] }
//   ],
//   "repoRoots": ["C:/Repos", "D:/Customers"],   // scanned one level deep to find local clones for PRs
//   "refreshMinutes": 3,
//   "sprintOnly": true   // only show work items in a sprint whose dates include today
{
  "organisations": [
${orgLines}
  ],
  "repoRoots": ${JSON.stringify(repoRoots)},
  "refreshMinutes": 3,
  "sprintOnly": true
}
`;
}

const REPO_ROOT_CANDIDATES = () => ["C:/Repos", "C:/Repo", "D:/Repos", "D:/Customers", join(homedir(), "source", "repos").replaceAll("\\", "/")];

/**
 * Load ~/.bc-cockpit/config.json, creating a commented starter file on first run.
 * `discoverOrganisations` (optional) seeds the starter file with the orgs the signed-in user belongs to.
 */
export async function loadConfig({ home = defaultHome(), discoverOrganisations } = {}) {
    const file = join(home, "config.json");
    let created = false;
    if (!existsSync(file)) {
        let organisations = [];
        if (discoverOrganisations) {
            try {
                organisations = (await discoverOrganisations()).map((name) => ({ name, projects: "*" }));
            } catch {
                organisations = [];
            }
        }
        const repoRoots = REPO_ROOT_CANDIDATES().filter((p) => existsSync(p));
        await atomicWrite(file, template({ organisations, repoRoots }));
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
