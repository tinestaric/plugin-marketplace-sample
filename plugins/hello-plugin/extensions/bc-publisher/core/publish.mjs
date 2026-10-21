import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { BC_API } from "./environments.mjs";
import { psq, runPwsh as defaultRunPwsh } from "./proc.mjs";
import { errMsg } from "./util.mjs";

export const SYNC_MODES = ["Add", "ForceSync"];
const SAAS_SCHEMA_MODE = { add: "synchronize", synchronize: "synchronize", forcesync: "forcesync", recreate: "recreate", clean: "recreate" };

export function normaliseMode(mode, env) {
    if (mode == null || mode === "") {
        const fromLaunch = String(env?.schemaUpdateMode ?? "").toLowerCase();
        return fromLaunch === "forcesync" ? "ForceSync" : "Add";
    }
    const m = SYNC_MODES.find((x) => x.toLowerCase() === String(mode).toLowerCase());
    if (!m) throw new Error(`mode must be one of ${SYNC_MODES.join(", ")}`);
    return m;
}

/** PowerShell for Publish-BcContainerApp: upgrade when an older version is installed, replace an identical version. */
export function containerPublishScript({ containerName, appFile, app, mode }) {
    return `
$ErrorActionPreference = 'Stop'
Import-Module BcContainerHelper -DisableNameChecking 3>$null | Out-Null
$c = ${psq(containerName)}
$appFile = ${psq(appFile)}
$installed = @(Get-BcContainerAppInfo -containerName $c -tenantSpecificProperties | Where-Object { "$($_.AppId)".ToLower() -eq ${psq(app.id)} })
$new = [version]${psq(app.version)}
if ($installed | Where-Object { [version]"$($_.Version)" -eq $new }) {
  Write-Host "Version $new is already published; unpublishing it first (data is kept)."
  UnPublish-BcContainerApp -containerName $c -appName ${psq(app.name)} -publisher ${psq(app.publisher)} -version ${psq(app.version)} -unInstall
}
$params = @{ containerName = $c; appFile = $appFile; skipVerification = $true; sync = $true; syncMode = ${psq(mode)} }
if ($installed | Where-Object { [version]"$($_.Version)" -lt $new }) { $params.upgrade = $true; Write-Host "Older version installed; upgrading." } else { $params.install = $true }
Publish-BcContainerApp @params
Write-Host '@@BCPUB@@OK'
`;
}

export async function publishToContainer({ env, app, appFile, mode, onOutput, signal, runPwsh = defaultRunPwsh }) {
    const script = containerPublishScript({ containerName: env.details.containerName, appFile, app, mode });
    const command = `Publish-BcContainerApp -containerName ${env.details.containerName} -appFile "${appFile}" -skipVerification -sync -syncMode ${mode} -install|-upgrade`;
    onOutput?.(`> ${command}`, "info");
    const r = await runPwsh(script, { onOutput, signal, timeoutMs: 30 * 60e3 });
    const ok = !r.cancelled && r.code === 0 && r.lines.some((l) => l.includes("@@BCPUB@@OK"));
    const errorLine = [...r.lines].reverse().find((l) => /error|exception|failed|cannot/i.test(l) && !l.includes("@@BCPUB@@"));
    return { ok, cancelled: r.cancelled, command, tail: r.lines.filter((l) => !l.includes("@@BCPUB@@")).slice(-60), error: ok ? null : errorLine ?? `PowerShell exited with code ${r.code}` };
}

/**
 * Publish via the development endpoint VS Code and BcContainerHelper use:
 * POST {api}/v2.0/{tenant}/{environment}/dev/apps?SchemaUpdateMode=… with the .app as multipart form data.
 */
export async function publishToSaas({ env, appFile, mode, onOutput, signal, fetch, getToken }) {
    const schema = SAAS_SCHEMA_MODE[mode.toLowerCase()] ?? "synchronize";
    const { tenant, environmentName } = env.details;
    const url = `${BC_API}/v2.0/${encodeURIComponent(tenant)}/${encodeURIComponent(environmentName)}/dev/apps?SchemaUpdateMode=${schema}`;
    const command = `POST ${url}`;
    onOutput?.(`> ${command}`, "info");
    try {
        const token = await getToken(tenant);
        const name = basename(appFile);
        const form = new FormData();
        form.append(name, new Blob([await readFile(appFile)], { type: "application/octet-stream" }), name);
        onOutput?.(`Uploading ${name} to ${environmentName}…`, "stdout");
        const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.any([AbortSignal.timeout(20 * 60e3), ...(signal ? [signal] : [])]) });
        const text = await res.text();
        if (res.ok) {
            onOutput?.(`Published (${res.status}).`, "stdout");
            return { ok: true, command, tail: [`HTTP ${res.status}`], error: null };
        }
        let msg = text;
        try {
            const j = JSON.parse(text);
            msg = j.Message ?? j.message ?? j.error?.message ?? text;
        } catch {
            /* not JSON */
        }
        const lines = String(msg).split(/\r?\n/).filter(Boolean);
        for (const l of lines) onOutput?.(l, "stderr");
        return { ok: false, command, tail: [`HTTP ${res.status} ${res.statusText}`, ...lines].slice(-60), error: `HTTP ${res.status}: ${lines[0] ?? res.statusText}` };
    } catch (e) {
        const cancelled = signal?.aborted ?? false;
        onOutput?.(cancelled ? "Cancelled." : errMsg(e), "stderr");
        return { ok: false, cancelled, command, tail: [errMsg(e)], error: cancelled ? "Cancelled" : errMsg(e) };
    }
}
