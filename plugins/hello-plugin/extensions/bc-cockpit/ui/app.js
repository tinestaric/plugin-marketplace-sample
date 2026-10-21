const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const api = async (path, body) => {
    const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Canvas-Request": "1" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
};

const state = {
    board: null,
    refreshing: false,
    problem: null,
    busy: new Set(),
    sigs: new Map(Object.entries(JSON.parse(localStorage.getItem("cockpit.sigs.v2") || "{}"))),
    recent: new Map(),
    collapsed: new Set(JSON.parse(localStorage.getItem("cockpit.collapsed.v2") || '["prs:open"]')),
    firstPaint: true,
};

// ---------- formatting ----------

function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}
const time = (iso) => (iso ? `<span data-time="${esc(iso)}" title="${esc(new Date(iso).toLocaleString())}">${ago(iso)}</span>` : "");
const badge = (text, cls = "") => `<span class="badge ${cls}">${esc(text)}</span>`;
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/** Working days (Mon–Fri) left in the sprint, counting today. */
function workDaysLeft(finishIso) {
    const end = Date.parse(finishIso) + 864e5;
    let n = 0;
    for (let d = new Date(new Date().toDateString()); d.getTime() < end; d.setDate(d.getDate() + 1)) if (d.getDay() % 6) n++;
    return n;
}

const WI_CLASS = { bug: "wi-bug", "user story": "wi-story", "product backlog item": "wi-story", issue: "wi-story", requirement: "wi-story", task: "wi-task", feature: "wi-feature", epic: "wi-epic" };
const CAT_CLASS = { Proposed: "", InProgress: "prog", Resolved: "ok" };
const VOTE = { approved: ["You approved", "ok"], "approved-suggestions": ["You approved w/ suggestions", "ok"], waiting: ["You: waiting for author", "warn"], rejected: ["You rejected", "bad"] };
const OVERALL = { approved: ["Approved", "ok"], waiting: ["Waiting for author", "warn"], rejected: ["Rejected", "bad"], pending: ["Review pending", ""] };
const PIPE = { failed: ["✗ Pipeline failed", "bad"], partial: ["Pipeline partially succeeded", "warn"], running: ["Pipeline running", "run"], succeeded: ["✓ Pipeline passed", "ok"], other: ["Pipeline canceled", ""] };

// ---------- change detection ----------

const sigOf = {
    wi: (w) => `${w.state}`,
    pr: (p) => [p.hasConflicts ? "c" : "", p.build?.state ?? "none", p.voteState, p.myVote].join("|"),
};
function describeChange(kind, before, item) {
    if (kind === "wi") return { text: `${before} → ${item.state}`, tone: "" };
    const [conf, pipe, overall] = before.split("|");
    if (item.hasConflicts && !conf) return { text: "conflicts", tone: "went-bad" };
    if (!item.hasConflicts && conf) return { text: "conflicts resolved", tone: "went-good" };
    if (item.build?.state === "failed" && pipe !== "failed") return { text: "pipeline failed", tone: "went-bad" };
    if (item.build?.state === "succeeded" && pipe !== "succeeded") return { text: "pipeline passed", tone: "went-good" };
    if (item.voteState !== overall) return { text: OVERALL[item.voteState]?.[0] ?? item.voteState, tone: item.voteState === "approved" ? "went-good" : item.voteState === "rejected" ? "went-bad" : "" };
    return { text: "updated", tone: "" };
}
function change(kind, item, sigs) {
    const sig = sigOf[kind](item);
    const before = state.sigs.get(item.key);
    sigs.set(item.key, sig);
    const recent = state.recent.get(item.key);
    if (recent && recent.until > Date.now()) return recent;
    if (before === undefined || before === sig) return null;
    const c = { ...describeChange(kind, before, item), until: Date.now() + 3000 };
    state.recent.set(item.key, c);
    return c;
}
const changeAttrs = (c) => (c ? ` data-change="${esc(c.text)}" data-tone="${c.tone}"` : "");
const changeTag = (c) => (c ? `<span class="tag">${esc(c.text)}</span>` : "");

// ---------- renderers ----------

function renderWork(b, sigs) {
    const items = b.workItems;
    if (!items.length) {
        return `<div class="empty">${b.config?.sprintOnly === false ? "Nothing assigned to you." : "Nothing assigned to you in a current sprint."}</div>`;
    }
    const groups = new Map();
    for (const w of items) {
        const k = `${w.org}/${w.project}/${w.sprint?.name ?? ""}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(w);
    }
    const multiOrg = (b.config?.organisations?.length ?? 0) > 1;
    return [...groups.entries()]
        .map(([k, ws]) => {
            const s = ws[0].sprint;
            const left = s ? workDaysLeft(s.finish) : null;
            const hasDates = s && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\d{1,2}[./-]\d{1,2}/i.test(s.name);
            const sum = `<span class="avatar" style="--hue:${hue(ws[0].project)}" aria-hidden="true">${esc(initials(ws[0].project))}</span>
              <span class="proj-name">${esc(ws[0].project)}</span>${multiOrg ? `<span class="muted">${esc(ws[0].org)}</span>` : ""}
              ${s ? `<span class="muted">${esc(s.name)}${hasDates ? "" : ` · ${day(s.start)} – ${day(s.finish)}`}</span>` : ""}
              <span class="gright">${s ? `<span class="left${left <= 2 ? " soon" : ""}">${left}d left</span>` : ""}<span class="count">${ws.length}</span></span>`;
            const rows = ws
                .map((w) => {
                    const c = change("wi", w, sigs);
                    return `<div class="row ${WI_CLASS[(w.type || "").toLowerCase()] ?? "wi-other"}" role="link" tabindex="0" data-key="${esc(w.key)}" data-url="${esc(w.url)}" title="Open #${esc(w.id)} in the browser"${changeAttrs(c)}>
              <div class="main"><span class="id">#${esc(w.id)}</span><span class="title">${esc(w.title)}</span>${changeTag(c)}</div>
              <div class="side">${badge(w.state, CAT_CLASS[w.stateCategory] ?? "")}<span class="prio${w.priority === 1 ? " p1" : ""}">${w.priority != null ? `P${esc(w.priority)}` : ""}</span><span class="ext" aria-hidden="true">↗</span></div>
            </div>`;
                })
                .join("");
            return section(`work:${k}`, sum, rows, "proj");
        })
        .join("");
}

/** Collapsible block; open/closed state survives re-renders and reloads. */
function section(id, summaryHtml, bodyHtml, cls = "") {
    return `<details class="sec ${cls}" data-sec="${esc(id)}"${state.collapsed.has(id) ? "" : " open"}><summary>${summaryHtml}</summary><div class="sec-body">${bodyHtml}</div></details>`;
}
const initials = (name) => String(name).replace(/^[A-Z]{1,4}\s*J?\d+\s*-\s*/, "").split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function prActions(p) {
    const out = [];
    const noClone = `No local clone of ${p.repo} found under repoRoots (${(state.board.config?.repoRoots ?? []).join(", ") || "none configured"}).`;
    const disabled = (busyKey) => (state.busy.has(busyKey) ? ' aria-disabled="true" data-busy="1"' : p.localPath ? "" : ` aria-disabled="true" title="${esc(noClone)}"`);
    if (p.hasConflicts) out.push(`<button type="button" class="btn small warn" data-act="conflict"${disabled(`c:${p.key}`)}${p.localPath ? ` title="Start an agent session in ${esc(p.localPath)} to resolve the conflicts"` : ""}>${state.busy.has(`c:${p.key}`) ? "Starting…" : "Resolve conflicts"}</button>`);
    if (p.build?.state === "failed" || p.build?.state === "partial") out.push(`<button type="button" class="btn small danger" data-act="failure"${disabled(`f:${p.key}`)}${p.localPath ? ` title="Start an agent session in ${esc(p.localPath)} to investigate the pipeline failure"` : ""}>${state.busy.has(`f:${p.key}`) ? "Starting…" : "Investigate failure"}</button>`);
    return out.join("");
}

function prRow(p, sigs) {
    const c = change("pr", p, sigs);
    const bad = p.hasConflicts || p.build?.state === "failed";
    const cls = bad ? "pr-bad" : p.build?.state === "running" ? "pr-run" : p.voteState === "approved" ? "pr-ok" : p.voteState === "waiting" ? "pr-wait" : "";
    const waitingOnMe = p.roles.includes("reviewer") && !p.roles.includes("author") && p.myVote === "none";
    const status = [
        p.hasConflicts ? badge("⚠ Merge conflicts", "bad") : "",
        p.build ? badge(...(PIPE[p.build.state] ?? [`Pipeline ${p.build.state}`, ""])) : badge("No pipeline"),
        waitingOnMe ? badge("Waiting on you", "warn") : badge(...(OVERALL[p.voteState] ?? [p.voteState, ""])),
        p.myVote && VOTE[p.myVote] && !waitingOnMe ? badge(...VOTE[p.myVote]) : "",
        p.isDraft ? badge("Draft") : "",
    ].join("");
    const who = p.roles.includes("author") ? "" : ` · by ${esc(p.author)}`;
    return `<div class="row ${cls}" role="link" tabindex="0" data-key="${esc(p.key)}" data-url="${esc(p.url)}" title="Open PR !${esc(p.id)} in the browser"${changeAttrs(c)}>
      <div class="main"><span class="crumb">${esc(p.project)} · ${esc(p.repo)} · !${esc(p.id)}</span>${changeTag(c)}</div>
      <div class="side">${prActions(p)}<span class="ext" aria-hidden="true">↗</span></div>
      <div class="main" style="grid-column:1/-1"><span class="title">${esc(p.title)}</span></div>
      <div class="meta">${status}<span>${time(p.createdDate)}${who}</span></div>
    </div>`;
}

function renderPrs(b, sigs) {
    const prs = b.pullRequests;
    if (!prs.length) return `<div class="empty">No active pull requests involving you.</div>`;
    const attention = prs.filter((p) => p.hasConflicts || p.build?.state === "failed" || p.build?.state === "partial");
    const waiting = prs.filter((p) => !attention.includes(p) && p.roles.includes("reviewer") && !p.roles.includes("author") && p.myVote === "none");
    const rest = prs.filter((p) => !attention.includes(p) && !waiting.includes(p));
    const group = (id, title, list, tone = "") =>
        list.length ? section(`prs:${id}`, `<span class="sec-title${tone ? ` ${tone}` : ""}">${esc(title)}</span><span class="gright"><span class="count">${list.length}</span></span>`, list.map((p) => prRow(p, sigs)).join("")) : "";
    return group("attention", "Needs attention", attention, "hot") + group("waiting", "Waiting on your review", waiting) + group("open", "Open", rest);
}

function renderHeader(b) {
    if (!b) {
        $("#summary").textContent = "Loading…";
        return;
    }
    const projects = new Set(b.workItems.map((w) => `${w.org}/${w.project}`)).size;
    const attention = b.pullRequests.filter((p) => p.hasConflicts || p.build?.state === "failed").length;
    $("#summary").innerHTML = [
        `<b>${b.workItems.length}</b> sprint item${b.workItems.length === 1 ? "" : "s"}${projects ? ` in ${projects} project${projects === 1 ? "" : "s"}` : ""}`,
        `<b>${b.pullRequests.length}</b> PR${b.pullRequests.length === 1 ? "" : "s"}`,
        attention ? `<span class="hot">${attention} need${attention === 1 ? "s" : ""} attention</span>` : "",
    ].filter(Boolean).join(" · ");
    $("#fetched").innerHTML = `Updated ${time(b.fetchedAt)}${b.stale ? " (cached)" : ""}`;
    const errs = b.errors ?? [];
    const btn = $("#errorsBtn");
    btn.hidden = !errs.length;
    btn.textContent = `⚠ ${errs.length}`;
    btn.title = `${errs.length} project${errs.length === 1 ? "" : "s"} could not be read`;
    $("#errorsPanel").innerHTML = `<ul>${errs.map((e) => `<li><b>${esc(e.org)}${e.project ? ` / ${esc(e.project)}` : ""}</b> · ${esc(e.area)} — ${esc(e.message)}</li>`).join("")}</ul>`;
    if (!errs.length) $("#errorsPanel").hidden = true;

    const banner = $("#banner");
    let html = "";
    if (state.problem) html = `<b>Configuration problem.</b> ${esc(state.problem)}`;
    else if (b.auth && !b.auth.ok) html = `<b>Not signed in to Azure DevOps.</b> Run <code>${esc(b.auth.command)}</code> (or set <code>AZDO_PAT</code>), then press Refresh.${b.stale ? " Showing the last cached data." : ""}`;
    else if (!(b.config?.organisations ?? []).length) html = `<b>No organisations configured.</b> Add them to <code>${esc(b.config?.file)}</code> and press Refresh.`;
    banner.hidden = !html;
    banner.innerHTML = html;
}

/** Re-render with FLIP so rows glide to their new position. */
function render() {
    const b = state.board;
    document.body.classList.toggle("refreshing", state.refreshing);
    renderHeader(b);
    if (!b) {
        for (const id of ["work", "prs"]) $(`#${id}`).innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
        return;
    }
    const before = new Map();
    if (!reduceMotion) for (const el of document.querySelectorAll("[data-key]")) before.set(el.dataset.key, el.getBoundingClientRect());
    const focusKey = document.activeElement?.closest?.("[data-key]")?.dataset.key;

    const sigs = new Map();
    $("#work").innerHTML = renderWork(b, sigs);
    $("#prs").innerHTML = renderPrs(b, sigs);
    $("#c-work").textContent = b.workItems.length;
    $("#c-prs").textContent = b.pullRequests.length;

    let i = 0;
    for (const el of document.querySelectorAll("[data-key]")) {
        if (el.dataset.change) el.classList.add("changed", ...(el.dataset.tone ? [el.dataset.tone] : []));
        const was = before.get(el.dataset.key);
        if (!was) {
            el.classList.add("enter");
            if (state.firstPaint) el.style.animationDelay = `${Math.min(i++, 20) * 20}ms`;
            continue;
        }
        const now = el.getBoundingClientRect();
        const dy = was.top - now.top;
        if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    if (focusKey) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus?.();
    if (b.auth?.ok !== false) {
        state.sigs = sigs;
        localStorage.setItem("cockpit.sigs.v2", JSON.stringify(Object.fromEntries(sigs)));
    }
    state.firstPaint = false;
}

// ---------- interactions ----------

function toast(text, tone = "") {
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    el.textContent = text;
    $("#toasts").append(el);
    setTimeout(() => (el.classList.add("out"), setTimeout(() => el.remove(), 300)), 4200);
}

async function openUrl(url) {
    try {
        await api("/api/open", { url });
    } catch {
        window.open(url, "_blank", "noopener");
    }
}

async function startSession(kind, p) {
    const key = `${kind === "conflict" ? "c" : "f"}:${p.key}`;
    state.busy.add(key);
    render();
    try {
        if (kind === "conflict") await api("/api/session/conflict", { org: p.org, project: p.project, repoId: p.repoId, prId: p.id });
        else await api("/api/session/failure", { org: p.org, project: p.project, buildId: p.build.id });
        toast(kind === "conflict" ? `Starting an agent session to resolve conflicts in !${p.id}…` : `Starting an agent session to investigate !${p.id}'s pipeline…`);
    } catch (e) {
        toast(`Could not start a session: ${e.message}`, "bad");
    } finally {
        setTimeout(() => {
            state.busy.delete(key);
            render();
        }, 1500);
    }
}

document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    const row = ev.target.closest(".row[data-url]");
    if (btn && row) {
        ev.stopPropagation();
        if (btn.getAttribute("aria-disabled") === "true") {
            if (!btn.dataset.busy && btn.title) toast(btn.title, "bad");
            return;
        }
        const p = state.board.pullRequests.find((x) => x.key === row.dataset.key);
        if (p) startSession(btn.dataset.act, p);
        return;
    }
    if (row) openUrl(row.dataset.url);
});
document.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.(".row[data-url]")) {
        ev.preventDefault();
        openUrl(ev.target.dataset.url);
    }
});

document.addEventListener(
    "toggle",
    (ev) => {
        const d = ev.target.closest?.("details[data-sec]");
        if (!d) return;
        if (d.open) state.collapsed.delete(d.dataset.sec);
        else state.collapsed.add(d.dataset.sec);
        localStorage.setItem("cockpit.collapsed.v2", JSON.stringify([...state.collapsed]));
    },
    true,
);

$("#refreshBtn").addEventListener("click", async () => {
    state.refreshing = true;
    render();
    try {
        await api("/api/refresh", {});
    } catch (e) {
        toast(`Refresh failed: ${e.message}`, "bad");
    }
});
$("#errorsBtn").addEventListener("click", () => {
    const panel = $("#errorsPanel");
    panel.hidden = !panel.hidden;
    $("#errorsBtn").setAttribute("aria-expanded", String(!panel.hidden));
});
setInterval(() => {
    for (const el of document.querySelectorAll("[data-time]")) el.textContent = ago(el.dataset.time);
}, 30000);

// ---------- live updates ----------

function connect() {
    const es = new EventSource("/api/events");
    es.addEventListener("board", (e) => {
        const b = JSON.parse(e.data);
        if (!b) return render();
        const same = state.board && state.board.fetchedAt === b.fetchedAt && state.board.auth?.ok === b.auth?.ok && !!state.board.stale === !!b.stale;
        state.board = b;
        if (same && !state.problem) return;
        state.problem = null;
        render();
    });
    es.addEventListener("status", (e) => {
        state.refreshing = JSON.parse(e.data).refreshing;
        document.body.classList.toggle("refreshing", state.refreshing);
    });
    es.addEventListener("problem", (e) => {
        state.problem = JSON.parse(e.data).message;
        render();
    });
}

api("/api/board")
    .then(({ board, refreshing, problem }) => {
        state.board = board;
        state.refreshing = refreshing;
        state.problem = problem;
    })
    .catch(() => {})
    .finally(() => {
        render();
        connect();
    });
