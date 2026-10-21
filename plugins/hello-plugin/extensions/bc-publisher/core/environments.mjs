import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { psq } from "./proc.mjs";
import { errMsg, parseJsonc } from "./util.mjs";

export const BC_API = "https://api.businesscentral.dynamics.com";
export const ADMIN_API_VERSION = "v2.29";
const MARK = "@@BCPUB@@";

const lc = (s) => String(s ?? "").toLowerCase();
const isIpOrFqdn = (h) => h.includes(".") || h.includes(":") || h === "localhost";

/** AL launch configurations from one .vscode/launch.json text. */
export function parseLaunchJson(text, appPath) {
    const j = parseJsonc(text);
    return (j.configurations ?? [])
        .filter((c) => c && lc(c.type) === "al" && lc(c.request ?? "launch") === "launch")
        .map((c) => ({
            name: c.name ?? "AL target",
            environmentType: c.environmentType ?? (c.server ? "OnPrem" : "Sandbox"),
            environmentName: c.environmentName ?? null,
            tenant: c.tenant ?? null,
            server: c.server ?? null,
            serverInstance: c.serverInstance ?? null,
            authentication: c.authentication ?? null,
            schemaUpdateMode: c.schemaUpdateMode ?? "Synchronize",
            appPath,
        }));
}

export async function readLaunchTargets(appPaths, workspaceRoot) {
    const targets = [];
    const errors = [];
    for (const dir of [...new Set([workspaceRoot, ...appPaths].filter(Boolean))]) {
        const f = join(dir, ".vscode", "launch.json");
        let text;
        try {
            text = await readFile(f, "utf8");
        } catch {
            continue;
        }
        try {
            targets.push(...parseLaunchJson(text, dir));
        } catch (e) {
            errors.push({ source: "launch.json", message: `${f}: ${e.message}` });
        }
    }
    return { targets, errors };
}

/** PowerShell that lists BcContainerHelper containers with version, country, state and installed workspace apps. */
export function containerDiscoveryScript(appIds) {
    return `
$ErrorActionPreference = 'Stop'
try {
  $null = docker version --format '{{.Server.Version}}' 2>&1
  if ($LASTEXITCODE) { throw 'Docker engine is not running or not accessible to this user.' }
  Import-Module BcContainerHelper -DisableNameChecking 3>$null 6>$null | Out-Null
  $ids = @(${appIds.map(psq).join(", ")})
  $out = @()
  foreach ($n in @(Get-BcContainers 6>$null)) {
    $o = [ordered]@{ name = "$n"; running = $false; version = $null; country = $null; apps = @() }
    try { $o.running = ((docker inspect -f '{{.State.Running}}' $n 2>$null) -eq 'true') } catch {}
    try { $v = "$(Get-BcContainerNavVersion -containerOrImageName $n 6>$null)"; $p = $v -split '-'; $o.version = $p[0]; $o.country = $p[1] } catch {}
    if ($o.running -and $ids.Count) {
      try { $o.apps = @(Get-BcContainerAppInfo -containerName $n -tenantSpecificProperties 6>$null | Where-Object { $ids -contains "$($_.AppId)".ToLower() } | ForEach-Object { [ordered]@{ id = "$($_.AppId)".ToLower(); version = "$($_.Version)"; installed = [bool]$_.IsInstalled } }) } catch {}
    }
    $out += [pscustomobject]$o
  }
  Write-Output ('${MARK}' + (ConvertTo-Json -InputObject @($out) -Depth 5 -Compress))
} catch {
  Write-Output ('${MARK}ERR ' + $_.Exception.Message)
}`;
}

export function parseContainerOutput(lines) {
    const line = [...lines].reverse().find((l) => l.startsWith(MARK));
    if (!line) throw new Error("Container discovery produced no result (is PowerShell 7 with BcContainerHelper installed?)");
    const body = line.slice(MARK.length);
    if (body.startsWith("ERR ")) throw new Error(body.slice(4).trim());
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

/** List environments for each configured tenant via the BC Admin Center API. */
export async function fetchSaasEnvironments(tenants, { fetch, getToken }) {
    const envs = [];
    const errors = [];
    await Promise.all(
        tenants.map(async (t) => {
            try {
                const token = await getToken(t.id);
                const res = await fetch(`${BC_API}/admin/${ADMIN_API_VERSION}/applications/environments`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                    signal: AbortSignal.timeout(30000),
                });
                if (!res.ok) {
                    const hint = res.status === 403 ? " — your account needs BC admin rights (or delegated admin) in this tenant to list environments" : "";
                    throw new Error(`Admin Center API ${res.status}${hint}`);
                }
                const j = await res.json();
                for (const e of j.value ?? []) {
                    if (e.applicationFamily && e.applicationFamily !== "BusinessCentral") continue;
                    envs.push({ tenant: t, name: e.name, type: e.type, applicationVersion: e.applicationVersion ?? null, countryCode: e.countryCode ?? null, status: e.status ?? null });
                }
            } catch (e) {
                errors.push({ source: `tenant ${t.label}`, tenantId: t.id, message: errMsg(e) });
            }
        }),
    );
    return { envs, errors };
}

function saasId(tenantKey, name) {
    return `saas:${lc(tenantKey || "default")}:${lc(name || "sandbox")}`;
}

/**
 * Merge launch.json targets, local containers and SaaS environments into one list.
 * Each entry: { id, label, kind, source, details, isProduction, … }.
 */
export function mergeEnvironments({ launch = [], containers = null, saas = [], config, tenantErrors = [] }) {
    const map = new Map();
    const containerNames = new Set((containers ?? []).map((c) => lc(c.name)));
    const add = (id, init) => {
        if (!map.has(id)) map.set(id, { id, source: [], launchNames: [], apps: [], ...init });
        return map.get(id);
    };
    // A launch.json target without "tenant" means "whatever tenant you sign in to" — never guess which configured tenant that is.
    const tenantFor = (launchTenant) => (launchTenant ? config.tenants.find((t) => t.id === lc(launchTenant)) ?? { id: lc(launchTenant), label: launchTenant } : null);

    for (const c of containers ?? []) {
        const e = add(`container:${lc(c.name)}`, { kind: "container", label: c.name });
        e.source.push("BcContainerHelper");
        Object.assign(e, { state: c.running ? "running" : "stopped", version: c.version, country: c.country, apps: c.apps ?? [], details: { containerName: c.name } });
    }
    for (const s of saas) {
        const e = add(saasId(s.tenant.id, s.name), { kind: "saas", label: s.name });
        e.source.push("Admin Center API");
        Object.assign(e, { type: s.type, verified: true, state: s.status, version: s.applicationVersion, country: s.countryCode, tenant: s.tenant, details: { tenant: s.tenant.id, environmentName: s.name } });
    }
    for (const t of launch) {
        const type = lc(t.environmentType);
        let e;
        if (type === "sandbox" || type === "production") {
            const tenant = tenantFor(t.tenant);
            e = add(saasId(tenant?.id ?? t.tenant, t.environmentName), { kind: "saas", label: t.name, type: null, verified: false, tenant, state: "unknown" });
            e.details ??= { tenant: tenant?.id ?? t.tenant ?? null, environmentName: t.environmentName ?? "sandbox" };
            if (!e.verified && type === "production") e.declaredType = "Production";
            if (!e.verified && type === "sandbox") e.declaredType ??= "Sandbox";
        } else {
            let host = "";
            try {
                host = lc(new URL(t.server).hostname);
            } catch {
                host = lc(t.server);
            }
            const instance = t.serverInstance ?? "BC";
            if (containerNames.has(host) || (host && !isIpOrFqdn(host))) {
                e = add(`container:${host}`, { kind: "container", label: host, state: containers ? "missing" : "unknown", details: { containerName: host } });
            } else {
                e = add(`onprem:${host}/${lc(instance)}`, { kind: "onprem", label: t.name, state: "unknown", details: { server: t.server, serverInstance: instance, authentication: t.authentication } });
            }
        }
        if (!e.source.includes("launch.json")) e.source.push("launch.json");
        if (!e.launchNames.includes(t.name)) e.launchNames.push(t.name);
        e.schemaUpdateMode ??= t.schemaUpdateMode;
    }

    return [...map.values()].map((e) => {
        const isProduction = lc(e.type) === "production" || e.declaredType === "Production";
        const agentMayPublish = config.environments[e.id]?.agentMayPublish === true;
        const tenantError = e.kind === "saas" && !e.verified ? tenantErrors.find((t) => t.tenantId && t.tenantId === lc(e.details?.tenant))?.message : undefined;
        if (tenantError) e.verifyError = tenantError;
        return { ...e, isProduction, agentMayPublish, publishable: publishability({ ...e, isProduction }) };
    });
}

/** Can anyone publish here? Production and unverified SaaS types are always refused. */
export function publishability(env) {
    if (env.isProduction) return { ok: false, reason: "Production environments can never be published to from BC Publisher." };
    if (env.kind === "saas") {
        if (!env.verified || !env.type) {
            if (env.verifyError) return { ok: false, reason: `Environment type could not be confirmed, so publishing is refused: ${env.verifyError}` };
            return {
                ok: false,
                reason: env.details?.tenant
                    ? "Environment type could not be confirmed via the BC Admin Center API, so publishing is refused. List the tenant in ~/.bc-publisher/config.json (your account needs admin rights to list its environments)."
                    : 'This launch.json target has no "tenant", so its environment type cannot be confirmed and publishing is refused. Set "tenant" in launch.json and list that tenant in ~/.bc-publisher/config.json.',
            };
        }
        if (lc(env.type) !== "sandbox") return { ok: false, reason: `Unsupported environment type "${env.type}".` };
        if (!env.details?.tenant) return { ok: false, reason: "No tenant is known for this environment." };
        return { ok: true };
    }
    if (env.kind === "container") {
        if (env.state === "running") return { ok: true };
        if (env.state === "stopped") return { ok: false, reason: "Container is stopped. Start it first." };
        return { ok: false, reason: env.state === "missing" ? "No local container with this name exists." : "Container state unknown — Docker is not reachable." };
    }
    return { ok: false, reason: "On-prem publishing is not supported yet." };
}

/** Policy for a publish request, including who is asking. */
export function canPublish(env, { actor = "user", confirmed = false } = {}) {
    if (!env) return { ok: false, reason: "Unknown environment." };
    const base = publishability(env);
    if (!base.ok) return base;
    if (actor === "agent") {
        if (env.kind === "container" && !env.agentMayPublish) {
            return { ok: false, reason: `The agent may only publish to containers whose config entry has "agentMayPublish": true. Add "${env.id}": { "agentMayPublish": true } under "environments" in ~/.bc-publisher/config.json.` };
        }
        if (env.kind === "saas" && !confirmed) return { ok: false, needsConfirmation: true, reason: "Publishing to a SaaS sandbox requires the user's confirmation." };
    }
    return { ok: true };
}
