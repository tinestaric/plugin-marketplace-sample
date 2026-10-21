export const API = "api-version=7.1";

export class AzdoError extends Error {
    constructor(status, message, url) {
        super(message);
        this.code = "azdo_http";
        this.status = status;
        this.url = url;
    }
}

const enc = encodeURIComponent;
export const orgUrl = (org) => `https://dev.azure.com/${enc(org)}`;
export const projUrl = (org, project) => `${orgUrl(org)}/${enc(project)}`;

/** Thin REST client over fetch. Retries once on 401 with a fresh token. */
export function createClient({ fetch = globalThis.fetch, auth, timeoutMs = 30000 }) {
    async function request(url, { method = "GET", body, accept = "application/json" } = {}, retry = true) {
        const token = await auth.get();
        const res = await fetch(url, {
            method,
            headers: {
                Authorization: token.header,
                Accept: accept,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 && retry) {
            auth.invalidate();
            return request(url, { method, body, accept }, false);
        }
        if (!res.ok) {
            let msg = `${res.status} ${res.statusText || ""}`.trim();
            try {
                const t = await res.text();
                const j = JSON.parse(t);
                if (j?.message) msg += `: ${j.message}`;
            } catch {
                /* body not JSON */
            }
            throw new AzdoError(res.status, msg, url.replace(/\?.*$/, ""));
        }
        return res;
    }
    return {
        async get(url) {
            return (await request(url)).json();
        },
        async post(url, body) {
            return (await request(url, { method: "POST", body })).json();
        },
        async text(url) {
            return (await request(url, { accept: "text/plain" })).text();
        },
    };
}
