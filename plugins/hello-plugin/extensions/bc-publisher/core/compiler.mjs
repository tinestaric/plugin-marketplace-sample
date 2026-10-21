import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { parseAppJson } from "./apps.mjs";
import { spawnStreamed } from "./proc.mjs";
import { parseJsonc } from "./util.mjs";

const AL_EXT = /^ms-dynamics-smb\.al-(\d+)\.(\d+)\.(\d+)$/i;
const ALC_CANDIDATES = [["bin", "win32", "alc.exe"], ["bin", "alc.exe"], ["win32", "alc.exe"]];
const ANALYZERS = { CodeCop: "Microsoft.Dynamics.Nav.CodeCop.dll", UICop: "Microsoft.Dynamics.Nav.UICop.dll", PerTenantExtensionCop: "Microsoft.Dynamics.Nav.PerTenantExtensionCop.dll", AppSourceCop: "Microsoft.Dynamics.Nav.AppSourceCop.dll" };
const MISSING_SYMBOL_CODES = new Set(["AL1022", "AL1024"]);

/** Locate alc.exe in the newest installed AL Language extension (VS Code and VS Code Insiders). */
export async function findCompiler({ home = homedir(), override } = {}) {
    if (override) {
        if (!existsSync(override)) throw new Error(`alcPath from config does not exist: ${override}`);
        return { path: override, version: "custom", analyzersDir: resolve(override, "..") };
    }
    const roots = [join(home, ".vscode", "extensions"), join(home, ".vscode-insiders", "extensions")];
    const found = [];
    for (const root of roots) {
        for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
            const m = e.isDirectory() && e.name.match(AL_EXT);
            if (!m) continue;
            for (const parts of ALC_CANDIDATES) {
                const p = join(root, e.name, ...parts);
                if (existsSync(p)) {
                    found.push({ path: p, version: `${m[1]}.${m[2]}.${m[3]}`, key: [+m[1], +m[2], +m[3]] });
                    break;
                }
            }
        }
    }
    if (!found.length) throw new Error("No AL Language extension with alc.exe found under ~/.vscode/extensions or ~/.vscode-insiders/extensions.");
    found.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
    const best = found[0];
    const binDir = resolve(best.path, "..");
    const analyzersDir = existsSync(join(binDir, "Analyzers")) ? join(binDir, "Analyzers") : binDir;
    return { path: best.path, version: best.version, analyzersDir };
}

const DIAG_LOC = /^(.+?)\((\d+),(\d*)(?:,\d+,\d+)?\): (error|warning|info) ([A-Z]+\d+): (.*)$/;
const DIAG_BARE = /^(error|warning|info) ([A-Z]+\d+): (.*)$/;

/** Parse alc output into structured diagnostics. */
export function parseDiagnostics(lines) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(lines) ? lines : String(lines).split(/\r?\n/)) {
        const line = raw.trim();
        let d = null;
        let m;
        if ((m = line.match(DIAG_LOC))) d = { severity: m[4], code: m[5], file: m[1], line: +m[2], column: m[3] ? +m[3] : null, message: m[6] };
        else if ((m = line.match(DIAG_BARE))) d = { severity: m[1], code: m[2], file: null, line: null, column: null, message: m[3] };
        if (!d) continue;
        const key = `${d.severity}|${d.code}|${d.file}|${d.line}|${d.column}|${d.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(d);
    }
    return out;
}

export const hasMissingSymbols = (diags) => diags.some((d) => d.severity === "error" && (MISSING_SYMBOL_CODES.has(d.code) || /could not be found in the package cache/i.test(d.message)));

export async function readAppJson(appPath) {
    const file = join(appPath, "app.json");
    return parseAppJson(await readFile(file, "utf8"), file);
}

async function readSettings(appPath, workspaceRoot) {
    for (const dir of [appPath, workspaceRoot].filter(Boolean)) {
        const f = join(dir, ".vscode", "settings.json");
        if (existsSync(f)) {
            try {
                return { settings: parseJsonc(await readFile(f, "utf8")), dir };
            } catch {
                /* malformed settings → ignore */
            }
        }
    }
    return { settings: {}, dir: appPath };
}

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
export const appFileName = (app) => `${safeName(app.publisher)}_${safeName(app.name)}_${app.version}.app`;

/** Build the alc.exe argument list for an app, honouring .vscode/settings.json ruleset and analysers. */
export async function buildCompileArgs(appPath, { compiler, app, workspaceRoot }) {
    const { settings, dir } = await readSettings(appPath, workspaceRoot);
    const rel = (p) => {
        const s = String(p).replaceAll("${workspaceFolder}", dir);
        return isAbsolute(s) ? s : resolve(dir, s);
    };
    const cache = settings["al.packageCachePath"];
    const cacheDirs = (Array.isArray(cache) ? cache : cache ? [cache] : ["./.alpackages"]).map((p) => resolve(appPath, p.replace("${workspaceFolder}", appPath)));
    const outFile = join(appPath, appFileName(app));
    const args = [`/project:${appPath}`, `/packagecachepath:${cacheDirs.join(";")}`, `/out:${outFile}`];
    if (settings["al.ruleSetPath"]) args.push(`/ruleset:${rel(settings["al.ruleSetPath"])}`);
    if (settings["al.enableCodeAnalysis"] && Array.isArray(settings["al.codeAnalyzers"])) {
        for (const a of settings["al.codeAnalyzers"]) {
            const m = String(a).match(/^\$\{(\w+)\}$/);
            if (m && ANALYZERS[m[1]]) args.push(`/analyzer:${join(compiler.analyzersDir, ANALYZERS[m[1]])}`);
            else if (!m) args.push(`/analyzer:${rel(String(a).replace("${analyzerFolder}", compiler.analyzersDir))}`);
        }
    }
    const probing = settings["al.assemblyProbingPaths"];
    if (Array.isArray(probing) && probing.length) args.push(`/assemblyprobingpaths:${probing.map((p) => resolve(appPath, p)).join(";")}`);
    return { args, outFile, cacheDirs };
}

/** True if the compiled .app is newer than every source file (app.json and *.al). */
export async function isAppFresh(appPath, outFile) {
    let appTime;
    try {
        appTime = (await stat(outFile)).mtimeMs;
    } catch {
        return false;
    }
    const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (e.isDirectory()) {
                if (![".alpackages", ".git", "node_modules", ".output", ".snapshots"].includes(e.name.toLowerCase()) && !(await walk(join(dir, e.name)))) return false;
            } else if (/\.(al|json|xlf|rdlc|docx|xlsx|layout)$/i.test(e.name) && e.name.toLowerCase() !== "launch.json") {
                if ((await stat(join(dir, e.name))).mtimeMs > appTime) return false;
            }
        }
        return true;
    };
    return walk(appPath);
}

/** Compile an AL app with alc.exe, streaming output. */
export async function compile(appPath, { compiler, workspaceRoot, onOutput, signal }) {
    const app = await readAppJson(appPath);
    const { args, outFile, cacheDirs } = await buildCompileArgs(appPath, { compiler, app, workspaceRoot });
    await mkdir(cacheDirs[0], { recursive: true }).catch(() => {});
    const started = Date.now();
    const command = `alc.exe ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
    onOutput?.(`> ${command}`, "info");
    const r = await spawnStreamed(compiler.path, [...(compiler.prefixArgs ?? []), ...args], { onOutput, signal, cwd: appPath, timeoutMs: 15 * 60e3 });
    const diagnostics = parseDiagnostics(r.lines);
    const errors = diagnostics.filter((d) => d.severity === "error");
    return {
        app,
        ok: !r.cancelled && r.code === 0 && errors.length === 0,
        cancelled: r.cancelled,
        exitCode: r.code,
        outFile,
        command,
        compiler: { version: compiler.version, path: compiler.path },
        diagnostics,
        missingSymbols: hasMissingSymbols(diagnostics),
        durationMs: Date.now() - started,
        tail: r.lines.slice(-60),
    };
}
