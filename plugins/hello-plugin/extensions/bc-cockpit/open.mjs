// Open a URL in the user's default browser. Host-neutral: works for any host that runs this extension locally.
import { execFile } from "node:child_process";

const ALLOWED = /(^|\.)dev\.azure\.com$|\.visualstudio\.com$/i;

export function validateAzdoUrl(raw) {
    let u;
    try {
        u = new URL(String(raw));
    } catch {
        return null;
    }
    return u.protocol === "https:" && ALLOWED.test(u.hostname) ? u.toString() : null;
}

export function openInBrowser(url) {
    const [cmd, args] =
        process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    return new Promise((resolve) => {
        // explorer.exe exits with 1 even on success, so only spawn failures count.
        const child = execFile(cmd, args, { windowsHide: true }, () => resolve());
        child.on("error", () => resolve());
    });
}
