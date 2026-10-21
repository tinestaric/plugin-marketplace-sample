const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = async (path, body) => {
    const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Canvas-Request": "1" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
};

const S = {
    state: null,
    refreshing: false,
    jobs: new Map(),
    logs: new Map(),
    lastPhase: new Map(),
    selectedJob: null,
    showLog: new Set(),
    selected: new Set(),
    mode: localStorage.getItem("publisher.mode") === "ForceSync" ? "ForceSync" : "Add",
    collapsed: new Set(JSON.parse(localStorage.getItem("publisher.collapsed") || "[]")),
    flash: new Map(),
};
const LIVE = new Set(["queued", "running", "compiling", "publishing"]);
const isLive = (j) => LIVE.has(j.state);
const selKey = () => `publisher.sel:${S.state?.workspace?.root ?? ""}`;

function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}
const time = (iso) => (iso ? `<span data-time="${esc(iso)}" title="${esc(new Date(iso).toLocaleString())}">${ago(iso)}</span>` : "");
const short = (name) => String(name).replace(/^.*? - /, "");

function toast(text, tone = "") {
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    el.textContent = text;
    $("#toasts").append(el);
    setTimeout(() => (el.classList.add("out"), setTimeout(() => el.remove(), 300)), 4200);
}

function confirmDialog(title, text, okLabel = "Confirm") {
    const d = $("#confirm");
    $("#confirmTitle").textContent = title;
    $("#confirmText").textContent = text;
    $("#confirmOk").textContent = okLabel;
    d.returnValue = "";
    d.showModal();
    return new Promise((r) => d.addEventListener("close", () => r(d.returnValue === "ok"), { once: true }));
}

function section(id, title, count, body, cls = "") {
    return `<details class="sec ${cls}" data-sec="${esc(id)}"${S.collapsed.has(id) ? "" : " open"}><summary><span class="gdot" aria-hidden="true"></span>${title}<span class="count">${count}</span></summary><div class="sec-body">${body}</div></details>`;
}

// ---------- header ----------

function renderHeader() {
    const st = S.state;
    document.body.classList.toggle("refreshing", S.refreshing);
    $("#wsName").textContent = st?.workspace.name ?? "";
    $("#wsPath").textContent = st ? st.workspace.root : "Loading workspace…";
    $("#wsPath").title = st?.workspace.workspaceFile ? `Using ${st.workspace.workspaceFile}` : st?.workspace.root ?? "";
    const c = $("#compiler");
    if (st) {
        c.hidden = false;
        c.textContent = st.compiler.error ? "AL compiler not found" : `AL ${st.compiler.version}`;
        c.title = st.compiler.error ?? st.compiler.path;
        c.classList.toggle("bad", !!st.compiler.error);
    }
    const issues = st?.errors ?? [];
    const btn = $("#issuesBtn");
    btn.hidden = !issues.length;
    btn.textContent = `⚠ ${issues.length}`;
    btn.title = `${issues.length} discovery issue${issues.length === 1 ? "" : "s"}`;
    $("#issues").innerHTML = `<ul>${issues.map((e) => `<li><b>${esc(e.source)}</b> — ${esc(e.message)}</li>`).join("")}</ul>${st?.configFile ? `<p class="muted">Config: <span class="mono">${esc(st.configFile)}</span></p>` : ""}`;
    if (!issues.length) $("#issues").hidden = true;
    for (const b of document.querySelectorAll(".seg [data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
}

// ---------- apps ----------

function renderApps() {
    const st = S.state;
    if (!st) return ($("#apps").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>');
    const apps = st.apps;
    $("#c-apps").textContent = apps.length;
    if (!apps.length) {
        $("#apps").innerHTML = `<div class="empty">No <code>app.json</code> found under <code>${esc(st.workspace.root)}</code>.<br>Open a session in your AL workspace, or ask the agent to open BC Publisher with <code>workspaceRoot</code>.</div>`;
        return;
    }
    const compiling = new Set([...S.jobs.values()].filter((j) => isLive(j) && j.kind === "compile").flatMap((j) => j.appPaths));
    $("#apps").innerHTML = apps
        .map((a, i) => {
            const sel = S.selected.has(a.path);
            const last = st.lastCompiles?.[a.path.toLowerCase()];
            const busy = compiling.has(a.path);
            const res = busy
                ? `<span class="res"><span class="spin on" aria-hidden="true"></span>compiling</span>`
                : last
                  ? `<span class="res ${last.ok ? "ok" : "bad"}" title="Last compile ${new Date(last.at).toLocaleString()}${last.actor === "agent" ? " (by agent)" : ""}">${last.ok ? "✓ compiles" : last.errors ? `✗ ${last.errors} error${last.errors === 1 ? "" : "s"}` : "✗ failed"} · ${time(last.at)}</span>`
                  : "";
            return `<div class="row app-row${sel ? " sel" : ""}" data-path="${esc(a.path)}">
          <input type="checkbox" id="app-${i}" ${sel ? "checked" : ""} aria-label="Select ${esc(a.name)}">
          <label for="app-${i}" class="name" title="${esc(a.path)}"><span class="order" aria-hidden="true">${a.order + 1}</span>${esc(a.name)}</label>
          <div class="act"><button type="button" class="btn small" data-act="compile" ${busy ? "disabled" : ""}>Compile</button></div>
          <div class="sub2"><span>${esc(a.version)}</span><span>${a.dependsOn.length ? `needs ${esc(a.dependsOn.map(short).join(", "))}` : "base app"}</span>${a.cycle ? `<span class="res bad">dependency cycle</span>` : ""}${res}</div>
        </div>`;
        })
        .join("");
    const all = $("#selectAll");
    all.checked = apps.length > 0 && apps.every((a) => S.selected.has(a.path));
    all.indeterminate = !all.checked && apps.some((a) => S.selected.has(a.path));
}

// ---------- targets ----------

/** One-glance reason for a locked target; the full text stays in the tooltip. */
function shortReason(e) {
    const r = e.publishable?.reason ?? "";
    if (e.isProduction) return "production";
    if (/no "tenant"/.test(r)) return "no tenant in launch.json";
    if (/token|az login/i.test(r)) return `sign in to ${e.tenant?.label ?? "tenant"}`;
    if (/admin rights|403/.test(r)) return "no admin access";
    if (/stopped/i.test(r)) return "stopped";
    if (/Docker/i.test(r)) return "Docker not reachable";
    if (/not supported/i.test(r)) return "not supported yet";
    return "locked";
}

function envRow(e) {
    const st = S.state;
    const live = [...S.jobs.values()].find((j) => isLive(j) && j.environmentId === e.id);
    const last = st.lastRuns?.[e.id];
    const nSel = st.apps.filter((a) => S.selected.has(a.path)).length;
    const can = e.publishable?.ok;
    const facts = [e.isProduction ? `<span class="kind prod">production</span>` : `<span class="kind k-${esc(e.kind)}">${esc(e.kind === "saas" ? (e.type ?? e.declaredType ?? "saas") : e.kind)}</span>`];
    if (e.version) facts.push(`BC ${esc(e.version.split(".").slice(0, 2).join("."))}${e.country ? ` · ${esc(String(e.country).toUpperCase())}` : ""}`);
    if (e.state && e.state !== "unknown") facts.push(esc(e.state));
    if (last) facts.push(`<span class="res ${last.ok ? "ok" : "bad"}" title="${esc(last.appName)} ${esc(last.appVersion)}">${last.ok ? "✓" : "✗"} ${esc(short(last.appName))} · ${time(last.startedAt)}${last.actor === "agent" ? " · agent" : ""}</span>`);
    const pubTitle = !nSel ? "Select apps on the left first" : `Publish ${nSel} app${nSel === 1 ? "" : "s"} to ${e.label} (${S.mode})`;
    const signingIn = [...S.jobs.values()].some((j) => isLive(j) && j.kind === "signin");
    const needsSignIn = !can && !e.isProduction && e.kind === "saas" && e.details?.tenant && /token|az login/i.test(e.publishable?.reason ?? "");
    const act = can
        ? `<button type="button" class="btn small primary" data-act="publish" ${!nSel || live ? "disabled" : ""} title="${esc(pubTitle)}">${live ? esc(live.state) + "…" : `Publish${nSel ? ` ${nSel}` : ""}`}</button>`
        : needsSignIn
          ? `<button type="button" class="btn small primary" data-act="signin" ${signingIn ? "disabled" : ""} title="${esc(`Runs az login for ${e.tenant?.label ?? e.details.tenant}, then refreshes. ${e.publishable.reason}`)}">${live ? "Signing in…" : `Sign in to ${esc(e.tenant?.label ?? "tenant")}`}</button>`
          : `<span class="lock" title="${esc(e.publishable?.reason ?? "Publishing unavailable")}">🔒 ${esc(shortReason(e))}</span>`;
    const restart = e.kind === "container" && (e.state === "running" || e.state === "stopped") ? `<button type="button" class="btn small icon" data-act="restart" ${live ? "disabled" : ""} title="Restart ${esc(e.label)}" aria-label="Restart ${esc(e.label)}">↻</button>` : "";
    return `<div class="row env-row${can || needsSignIn ? "" : " locked"}${e.isProduction ? " prod" : ""} ${S.flash.get(e.id) ?? ""}" data-env="${esc(e.id)}" title="${esc(e.id)}">`
        + `
      <span class="dot ${live ? "busy" : esc(String(e.state ?? "").toLowerCase())}" aria-hidden="true"></span>
      <span class="name">${esc(e.label)}</span>
      <div class="act">${restart}${act}</div>
      <div class="sub2">${facts.join("<span>·</span>")}${needsSignIn ? `<span class="res bad">not signed in</span>` : ""}</div>
    </div>`;
}

function renderEnvs() {
    const st = S.state;
    if (!st) return ($("#envs").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>');
    const envs = st.environments;
    $("#c-envs").textContent = envs.length;
    if (!envs.length) {
        $("#envs").innerHTML = `<div class="empty">No targets found. Add AL configurations to <code>.vscode/launch.json</code>, start a BcContainerHelper container, or list tenants in <code>${esc(st.configFile ?? "~/.bc-publisher/config.json")}</code>.</div>`;
        return;
    }
    const groups = [];
    const push = (id, title, cls, items) => items.length && groups.push(section(`env:${id}`, title, items.length, items.map(envRow).join(""), cls));
    push("containers", "Local containers", "k-container", envs.filter((e) => e.kind === "container" && !e.isProduction));
    const byTenant = new Map();
    for (const e of envs.filter((x) => x.kind === "saas" && !x.isProduction)) {
        const t = e.tenant?.label ?? "Tenant not specified";
        if (!byTenant.has(t)) byTenant.set(t, []);
        byTenant.get(t).push(e);
    }
    for (const [t, items] of byTenant) push(`saas:${t}`, `SaaS · ${esc(t)}`, "k-saas", items);
    push("onprem", "On-prem", "k-onprem", envs.filter((e) => e.kind === "onprem" && !e.isProduction));
    push("prod", "Production · read-only", "prod", envs.filter((e) => e.isProduction));
    $("#envs").innerHTML = groups.join("");
}

// ---------- output ----------

function stepClass(job, step, i) {
    const steps = job.steps;
    if (job.state === "done") return "done";
    const failedAt = steps.indexOf(S.lastPhase.get(job.id) ?? steps[1]);
    if (job.state === "failed" || job.state === "cancelled") return i < failedAt ? "done" : i === failedAt ? "failed" : "";
    const cur = job.state === "running" ? Math.max(1, steps.indexOf("running")) : steps.indexOf(job.state);
    return i < cur ? "done" : i === cur ? "active" : "";
}
const STEP = { queued: "Queued", compiling: "Compile", publishing: "Publish", running: "Run", done: "Done" };

function lineClass(l) {
    if (l.line.startsWith("✓")) return "l-ok";
    if (l.stream === "info" || l.line.startsWith("> ") || l.line.startsWith("── ")) return "l-info";
    if (/\berror\b|✗|exception|failed/i.test(l.line) || l.stream === "stderr") return "l-err";
    if (/\bwarning\b/i.test(l.line)) return "l-warn";
    return "";
}
const logHtml = (lines, cls = "") => lines.map((l) => `<span class="${lineClass(l)} ${cls}">${esc(l.line)}\n</span>`).join("");

function resultBox(job) {
    if (job.state === "done") {
        const ok = job.runs.filter((r) => r.ok);
        if (job.kind === "signin") return `<div class="result ok">✓ Signed in. Targets refreshed.</div>`;
        return ok.length ? `<div class="result ok">✓ ${ok.map((r) => `${esc(short(r.appName))} <span class="muted">${(r.durationMs / 1000).toFixed(0)}s</span>`).join(" · ")}</div>` : "";
    }
    if (job.state !== "failed" && job.state !== "cancelled") return "";
    const run = job.runs.find((r) => !r.ok);
    if (!run) return job.error ? `<div class="result bad"><div class="head"><b>✗ ${esc(job.error)}</b></div></div>` : "";
    const diags = [...(run.diagnostics ?? []).filter((d) => d.severity === "error"), ...(run.diagnostics ?? []).filter((d) => d.severity === "warning")];
    const shown = diags.slice(0, 25);
    const containers = (S.state?.environments ?? []).filter((e) => e.kind === "container" && e.state === "running");
    return `<div class="result bad">
      <div class="head"><b>✗ ${esc(short(run.appName))}: ${esc(run.error ?? "failed")}</b>
        ${run.cancelled ? "" : `<button type="button" class="btn small primary" data-act="ask" data-run="${esc(run.id)}">Ask agent to fix</button>`}</div>
      ${shown.length ? `<ul class="diags">${shown.map((d) => `<li class="${esc(d.severity)}"><span class="code">${esc(d.code)}</span><span>${esc(d.message)}</span>${d.file ? `<span class="loc">${esc(d.file)}${d.line ? `(${d.line},${d.column ?? ""})` : ""}</span>` : ""}</li>`).join("")}</ul>` : ""}
      ${diags.length > shown.length ? `<div class="note">…and ${diags.length - shown.length} more</div>` : ""}
      ${run.missingSymbols ? `<div class="note">📦 Symbols missing.${containers.length ? ` Download from: ${containers.map((c) => `<button type="button" class="btn small" data-act="symbols" data-env="${esc(c.id)}" data-app="${esc(run.appPath)}">${esc(c.label)}</button>`).join(" ")}` : " Start a container to download them from."}</div>` : ""}
    </div>`;
}

function renderJobs() {
    const jobs = [...S.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $("#output").hidden = !jobs.length;
    if (!jobs.length) return;
    $("#jobTabs").innerHTML = jobs
        .slice(0, 6)
        .map((j) => `<button type="button" role="tab" class="job-tab" data-job="${esc(j.id)}" aria-selected="${j.id === S.selectedJob}"><span class="d ${isLive(j) ? "live" : esc(j.state)}"></span>${esc(j.title)}</button>`)
        .join("");
    const job = S.jobs.get(S.selectedJob) ?? jobs[0];
    S.selectedJob = job.id;
    const showLog = S.showLog.has(job.id) || isLive(job);
    $("#jobView").innerHTML = `<div class="job">
      <div class="job-line"><span class="job-title">${esc(job.title)}</span>${job.actor === "agent" ? `<span class="muted">by agent</span>` : ""}<span class="muted">${time(job.startedAt ?? job.createdAt)}</span>
        <span class="steps" aria-label="Progress">${job.steps.map((s, i) => `${i ? '<span class="sep" aria-hidden="true">›</span>' : ""}<span class="s ${stepClass(job, s, i)}">${esc(STEP[s] ?? s)}</span>`).join("")}</span>
        <span class="right">${isLive(job) ? `<button type="button" class="btn small danger" data-act="cancel">Cancel</button>` : `<button type="button" class="btn small" data-act="toggle-log">${showLog ? "Hide log" : "Show log"}</button>`}</span></div>
      ${resultBox(job)}
      <pre class="log" id="log" tabindex="0" aria-label="Job output" ${showLog ? "" : "hidden"}>${logHtml(S.logs.get(job.id) ?? [])}</pre>
    </div>`;
    const log = $("#log");
    if (log) log.scrollTop = log.scrollHeight;
}

function appendLog(jobId, lines) {
    if (!S.logs.has(jobId)) S.logs.set(jobId, []);
    const all = S.logs.get(jobId);
    all.push(...lines);
    if (all.length > 3000) all.splice(0, all.length - 3000);
    if (jobId !== S.selectedJob) return;
    const log = $("#log");
    if (!log || log.hidden) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.insertAdjacentHTML("beforeend", logHtml(lines, "new"));
    if (stick) log.scrollTop = log.scrollHeight;
}

function renderAll() {
    renderHeader();
    renderApps();
    renderEnvs();
    renderJobs();
}

// ---------- actions ----------

const saveSel = () => localStorage.setItem(selKey(), JSON.stringify([...S.selected]));

async function post(path, body, what) {
    try {
        const r = await api(path, body);
        if (r.jobId) S.selectedJob = r.jobId;
        return r;
    } catch (e) {
        toast(`${what}: ${e.message}`, "bad");
        return null;
    }
}

document.addEventListener("change", (ev) => {
    const row = ev.target.closest(".app-row");
    if (row && ev.target.type === "checkbox") {
        if (ev.target.checked) S.selected.add(row.dataset.path);
        else S.selected.delete(row.dataset.path);
    } else if (ev.target.id === "selectAll") {
        S.selected = new Set(ev.target.checked ? S.state.apps.map((a) => a.path) : []);
    } else return;
    saveSel();
    renderApps();
    renderEnvs();
});

document.addEventListener(
    "toggle",
    (ev) => {
        const d = ev.target.closest?.("details[data-sec]");
        if (!d) return;
        if (d.open) S.collapsed.delete(d.dataset.sec);
        else S.collapsed.add(d.dataset.sec);
        localStorage.setItem("publisher.collapsed", JSON.stringify([...S.collapsed]));
    },
    true,
);

document.addEventListener("click", async (ev) => {
    const modeBtn = ev.target.closest(".seg [data-mode]");
    if (modeBtn) {
        S.mode = modeBtn.dataset.mode;
        localStorage.setItem("publisher.mode", S.mode);
        renderHeader();
        renderEnvs();
        return;
    }
    const tab = ev.target.closest(".job-tab");
    if (tab) {
        S.selectedJob = tab.dataset.job;
        if (!S.logs.has(S.selectedJob)) S.logs.set(S.selectedJob, (await api(`/api/log?jobId=${encodeURIComponent(S.selectedJob)}`).catch(() => ({ lines: [] }))).lines);
        return renderJobs();
    }
    const b = ev.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const envEl = b.closest("[data-env]");
    const env = envEl && S.state.environments.find((e) => e.id === envEl.dataset.env);
    switch (b.dataset.act) {
        case "compile":
            await post("/api/compile", { appPath: b.closest(".app-row").dataset.path }, "Compile");
            break;
        case "publish": {
            const list = S.state.apps.filter((a) => S.selected.has(a.path));
            if (env.kind === "saas" && !(await confirmDialog("Publish to SaaS sandbox", `Publish ${list.map((a) => a.name).join(", ")} to "${env.label}"${env.tenant ? ` (${env.tenant.label})` : ""} with ${S.mode}?`, "Publish"))) break;
            if (S.mode === "ForceSync" && env.kind !== "saas" && !(await confirmDialog("ForceSync", `ForceSync can drop data on "${env.label}". Continue?`, "Publish"))) break;
            await post("/api/publish", { appPaths: list.map((a) => a.path), environmentId: env.id, mode: S.mode }, "Publish");
            break;
        }
        case "signin":
            if (await post("/api/signin", { tenantId: env.details.tenant, environmentId: env.id }, "Sign in")) toast(`Complete the sign-in for ${env.tenant?.label ?? "the tenant"} in the window that opens.`);
            break;
        case "restart":
            if (await confirmDialog("Restart container", `Restart "${env.label}"? Sessions in the container will be disconnected.`, "Restart")) await post("/api/restart", { environmentId: env.id }, "Restart");
            break;
        case "symbols":
            await post("/api/symbols", { appPath: b.dataset.app, environmentId: b.dataset.env }, "Symbols");
            break;
        case "cancel":
            await post("/api/cancel", { jobId: S.selectedJob }, "Cancel");
            break;
        case "toggle-log":
            if (S.showLog.has(S.selectedJob)) S.showLog.delete(S.selectedJob);
            else S.showLog.add(S.selectedJob);
            renderJobs();
            break;
        case "ask":
            b.disabled = true;
            b.textContent = "Sending…";
            if (await post("/api/ask-agent", { runId: b.dataset.run }, "Ask agent")) {
                b.textContent = "Sent to agent ✓";
                toast("Sent the diagnostics to the agent.");
            } else {
                b.disabled = false;
                b.textContent = "Ask agent to fix";
            }
            break;
    }
});

$("#refreshBtn").addEventListener("click", () => {
    S.refreshing = true;
    renderHeader();
    post("/api/refresh", {}, "Refresh");
});
$("#issuesBtn").addEventListener("click", () => {
    const p = $("#issues");
    p.hidden = !p.hidden;
    $("#issuesBtn").setAttribute("aria-expanded", String(!p.hidden));
});
setInterval(() => document.querySelectorAll("[data-time]").forEach((el) => (el.textContent = ago(el.dataset.time))), 30000);

// ---------- live updates ----------

function applyState(st) {
    if (!st) return;
    const firstForRoot = !S.state || S.state.workspace.root !== st.workspace.root;
    S.state = st;
    if (firstForRoot) {
        const saved = JSON.parse(localStorage.getItem(selKey()) || "null");
        const valid = new Set(st.apps.map((a) => a.path));
        S.selected = new Set(saved ? saved.filter((p) => valid.has(p)) : []);
    }
    for (const j of st.jobs ?? []) S.jobs.set(j.id, j);
    renderAll();
}

function connect() {
    const es = new EventSource("/api/events");
    es.addEventListener("state", (e) => applyState(JSON.parse(e.data)));
    es.addEventListener("status", (e) => {
        S.refreshing = JSON.parse(e.data).refreshing;
        renderHeader();
    });
    es.addEventListener("job", (e) => {
        const j = JSON.parse(e.data);
        const prev = S.jobs.get(j.id);
        if (["compiling", "publishing", "running"].includes(j.state)) S.lastPhase.set(j.id, j.state);
        S.jobs.set(j.id, j);
        if (!prev || isLive(j)) S.selectedJob = j.id;
        if (prev && isLive(prev) && !isLive(j)) {
            if (j.environmentId) {
                S.flash.set(j.environmentId, j.state === "done" ? "flash-ok" : "flash-bad");
                setTimeout(() => S.flash.delete(j.environmentId), 1900);
            }
            toast(`${j.title}: ${j.state}`, j.state === "done" ? "" : "bad");
        }
        renderApps();
        renderEnvs();
        renderJobs();
    });
    es.addEventListener("log", (e) => {
        const { jobId, lines } = JSON.parse(e.data);
        appendLog(jobId, lines);
    });
}

renderAll();
api("/api/state")
    .then(({ state, refreshing }) => {
        S.refreshing = refreshing;
        applyState(state);
    })
    .catch(() => {})
    .finally(connect);
