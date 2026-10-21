// Minimal same-origin HTTP + SSE server for a canvas UI. Host-neutral.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function readJsonBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
        chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "Invalid JSON body");
    }
}

/**
 * Start a UI server on 127.0.0.1 with an ephemeral port.
 * routes: { "GET /api/x": async ({ query, body }) => json }.
 * POSTs must carry the `X-Canvas-Request: 1` header and a JSON content type, which blocks
 * cross-site form posts; the Host header must be loopback, which blocks DNS rebinding.
 */
export function startUiServer({ uiDir, routes, sse, log = () => {} }) {
    const clients = new Set();
    const server = createServer(async (req, res) => {
        const host = (req.headers.host || "").replace(/:\d+$/, "");
        if (host !== "127.0.0.1" && host !== "localhost") {
            res.writeHead(403).end();
            return;
        }
        const url = new URL(req.url, "http://127.0.0.1");
        const send = (status, body, type = "application/json; charset=utf-8") => {
            res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
        };
        try {
            if (req.method === "GET" && url.pathname === "/api/events") {
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
                res.write("retry: 2000\n\n");
                clients.add(res);
                req.on("close", () => clients.delete(res));
                for (const [event, data] of (await sse?.()) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                return;
            }
            const handler = routes[`${req.method} ${url.pathname}`];
            if (handler) {
                if (req.method !== "GET") {
                    if (req.headers["x-canvas-request"] !== "1" || !/^application\/json/.test(req.headers["content-type"] || "")) {
                        throw new HttpError(403, "Missing canvas request headers");
                    }
                }
                const body = req.method === "GET" ? {} : await readJsonBody(req);
                send(200, (await handler({ query: url.searchParams, body })) ?? { ok: true });
                return;
            }
            if (req.method === "GET") {
                const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
                if (/^[a-z0-9-]+\.(html|js|css|svg)$/i.test(file)) {
                    const content = await readFile(join(uiDir, file)).catch(() => null);
                    if (content) return send(200, content, TYPES[extname(file)]);
                }
            }
            send(404, { error: "Not found" });
        } catch (e) {
            const status = e instanceof HttpError ? e.status : e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
            if (status >= 500) log(`${req.method} ${url.pathname} failed: ${e.message}`);
            send(status, { error: e.message, code: e.code });
        }
    });
    const keepAlive = setInterval(() => {
        for (const c of clients) c.write(": ping\n\n");
    }, 25000);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/`,
                broadcast(event, data) {
                    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                    for (const c of clients) c.write(msg);
                },
                close() {
                    clearInterval(keepAlive);
                    for (const c of clients) c.end();
                    clients.clear();
                    return new Promise((r) => server.close(() => r()));
                },
            });
        });
    });
}
