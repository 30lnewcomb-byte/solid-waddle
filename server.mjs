import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import httpProxy from "http-proxy";

const root = path.dirname(fileURLToPath(import.meta.url));
const browserStatePath = path.join(root, ".sideview-browser-state.json");
const memoryStorePath = path.join(root, ".solid-waddle-memory.json");
const execFileAsync = promisify(execFile);
const allowedDomains = ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "chatgptusercontent.com"];
const maxResponseBytes = 15 * 1024 * 1024;
const maxRedirects = 6;
const webdriverEndpoint = "http://127.0.0.1:4444";
let webdriverSessionId = null;
let webdriverSessionPromise = null;
let browserStartPromise = null;
const remoteProxy = httpProxy.createProxyServer({
    target: "http://127.0.0.1:7900",
    changeOrigin: true,
    ws: true,
});

remoteProxy.on("proxyRes", (_proxyResponse, _request, response) => {
    response.setHeader("x-frame-options", "SAMEORIGIN");
    response.setHeader("content-security-policy", "frame-ancestors 'self'");
    response.setHeader("cross-origin-resource-policy", "same-origin");
});

remoteProxy.on("error", (error, _request, response) => {
    if (response && typeof response.writeHead === "function" && !response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end(`Remote browser display unavailable: ${error.message}`);
    } else {
        response?.destroy?.(error);
    }
});

function isSameOriginRequest(request, requireOrigin = false) {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
    const origin = request.headers.origin;
    if (!origin) return !requireOrigin;
    try {
        return new URL(origin).host.toLowerCase() === request.headers.host?.toLowerCase();
    } catch {
        return false;
    }
}

export function isDockerBrowserAddress(address) {
    const normalized = address?.replace(/^::ffff:/, "");
    const octets = normalized?.split(".").map(Number);
    return Boolean(octets && octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

export function isPublicIpv4(address) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    const [first, second, third] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
    if (first === 100 && second >= 64 && second <= 127) return false;
    if (first === 169 && second === 254) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && (second === 168 || (second === 0 && third === 0) || (second === 0 && third === 2))) return false;
    if (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)) return false;
    if (first === 203 && second === 0 && third === 113) return false;
    return true;
}

function rejectTunnel(socket, code, reason) {
    const body = `${reason}\n`;
    socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function handleBrowserConnect(request, client, head) {
    if (!isDockerBrowserAddress(request.socket.remoteAddress)) {
        rejectTunnel(client, 403, "Only the local browser container may use this tunnel.");
        return;
    }

    let target;
    try {
        target = new URL(`https://${request.url}`);
    } catch {
        rejectTunnel(client, 400, "Invalid CONNECT target.");
        return;
    }
    if ((target.port && target.port !== "443") || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
        rejectTunnel(client, 403, "Only HTTPS CONNECT traffic on port 443 is allowed.");
        return;
    }

    let addresses;
    try {
        addresses = await lookup(target.hostname, { all: true, family: 4, verbatim: true });
    } catch {
        rejectTunnel(client, 502, "Target DNS lookup failed.");
        return;
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address))) {
        rejectTunnel(client, 403, "Private and non-public target addresses are blocked.");
        return;
    }

    const upstream = net.connect({ host: addresses[0].address, port: 443 });
    let established = false;
    upstream.once("connect", () => {
        if (client.destroyed) {
            upstream.destroy();
            return;
        }
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Sideview\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
    });
    upstream.once("error", (error) => {
        if (!established && !client.destroyed) rejectTunnel(client, 502, `Tunnel connection failed: ${error.message}`);
        else client.destroy(error);
    });
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
}

export function parseBrowserTarget(value) {
    const address = value.trim();
    if (!address) throw new Error("Enter a web address.");
    const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`;
    const target = new URL(withProtocol);
    if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password) {
        throw new Error("Only HTTP or HTTPS web addresses without embedded credentials are supported.");
    }
    return target.href;
}

async function loadSavedBrowserPage() {
    try {
        const saved = JSON.parse(await readFile(browserStatePath, "utf8"));
        return { url: parseBrowserTarget(saved.url), title: typeof saved.title === "string" ? saved.title : "" };
    } catch {
        return null;
    }
}

let savedBrowserPage = await loadSavedBrowserPage();
let browserStateWrite = Promise.resolve();

async function rememberBrowserPage(url, title) {
    let safeUrl;
    try {
        safeUrl = parseBrowserTarget(url);
    } catch {
        return;
    }
    const safeTitle = typeof title === "string" ? title.slice(0, 500) : "";
    if (savedBrowserPage?.url === safeUrl && savedBrowserPage.title === safeTitle) return;
    savedBrowserPage = { url: safeUrl, title: safeTitle, savedAt: new Date().toISOString() };
    const serialized = JSON.stringify(savedBrowserPage, null, 2);
    browserStateWrite = browserStateWrite.catch(() => {}).then(async () => {
        const temporaryPath = `${browserStatePath}.tmp`;
        await writeFile(temporaryPath, serialized, { mode: 0o600 });
        await rename(temporaryPath, browserStatePath);
    });
    await browserStateWrite;
}

function isBlankBrowserPage(url) {
    return ["data:,", "about:blank", "chrome://newtab/", "chrome://new-tab-page/"].includes(url);
}

async function openReplacementWindow(sessionId) {
    const response = await fetch(`${webdriverEndpoint}/session/${sessionId}/window/new`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "tab" }),
        signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    const handle = data.value?.handle;
    if (!response.ok || !handle) return false;

    const switched = await fetch(`${webdriverEndpoint}/session/${sessionId}/window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
        signal: AbortSignal.timeout(10000),
    });
    if (!switched.ok) return false;

    const probe = await fetch(`${webdriverEndpoint}/session/${sessionId}/url`, {
        signal: AbortSignal.timeout(5000),
    });
    const probeData = await probe.json();
    return probe.ok && !probeData.value?.error;
}

async function probeWebdriverSession(sessionId) {
    const response = await fetch(`${webdriverEndpoint}/session/${sessionId}/url`, {
        signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (response.ok && !data.value?.error) return true;
    if (data.value?.error === "no such window") return openReplacementWindow(sessionId);
    if (data.value?.error === "tab crashed") {
        await fetch(`${webdriverEndpoint}/session/${sessionId}`, {
            method: "DELETE",
            signal: AbortSignal.timeout(10000),
        });
        return false;
    }
    if (data.value?.error === "invalid session id") return false;
    throw new Error(data.value?.message || "Could not verify the current Chrome session.");
}

async function ensureWebdriverSession() {
    if (webdriverSessionId) {
        if (await probeWebdriverSession(webdriverSessionId)) return webdriverSessionId;
        webdriverSessionId = null;
    }
    if (!webdriverSessionPromise) {
        webdriverSessionPromise = (async () => {
            let ready = false;
            for (let attempt = 0; attempt < 10; attempt += 1) {
                let statusData;
                try {
                    const status = await fetch(`${webdriverEndpoint}/status`, { signal: AbortSignal.timeout(3000) });
                    statusData = await status.json();
                    ready = status.ok && Boolean(statusData.value?.ready);
                } catch {
                    ready = false;
                }

                const slots = statusData?.value?.nodes?.flatMap((node) => node.slots || []) || [];
                const activeSessionId = slots.map((slot) => slot.session?.sessionId).find(Boolean);
                if (activeSessionId) {
                    if (await probeWebdriverSession(activeSessionId)) {
                        webdriverSessionId = activeSessionId;
                        return activeSessionId;
                    }
                    try {
                        await fetch(`${webdriverEndpoint}/session/${activeSessionId}`, {
                            method: "DELETE",
                            signal: AbortSignal.timeout(5000),
                        });
                    } catch {
                        // A concurrent cleanup may already have removed this session.
                    }
                    ready = false;
                }
                if (ready) break;
                if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            if (!ready) throw new Error("Remote Chrome did not become ready. Check the Selenium container.");

            const response = await fetch(`${webdriverEndpoint}/session`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    capabilities: {
                        alwaysMatch: {
                            browserName: "chrome",
                            "goog:chromeOptions": {
                                args: [
                                    "--start-maximized",
                                    "--proxy-server=http://host.docker.internal:8000",
                                    "--user-data-dir=/home/seluser/.config/sideview-profile",
                                ],
                            },
                        },
                    },
                }),
                signal: AbortSignal.timeout(30000),
            });
            const data = await response.json();
            const sessionId = data.value?.sessionId || data.sessionId;
            if (!response.ok || !sessionId) throw new Error(data.value?.message || "Could not start remote Chrome.");
            webdriverSessionId = sessionId;
            return sessionId;
        })();
    }
    try {
        return await webdriverSessionPromise;
    } finally {
        webdriverSessionPromise = null;
    }
}

async function webdriverRequest(method, command, body) {
    const sessionId = await ensureWebdriverSession();
    const response = await fetch(`${webdriverEndpoint}/session/${sessionId}/${command}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok || data.value?.error) {
        throw new Error(data.value?.message || "Remote Chrome command failed.");
    }
    return data.value;
}

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
    let body = "";
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 10000) throw new Error("Request body is too large.");
    }
    return JSON.parse(body || "{}");
}


const memoryCategories = new Set(["preference", "project", "fact", "decision", "reminder"]);
let savedMemories = await loadMemories();
let memoryWriteQueue = Promise.resolve();

async function loadMemories() {
    try {
        const parsed = JSON.parse(await readFile(memoryStorePath, "utf8"));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) =>
            item && typeof item.id === "string" &&
            typeof item.text === "string" &&
            memoryCategories.has(item.category) &&
            typeof item.createdAt === "string" &&
            typeof item.updatedAt === "string"
        ).slice(0, 1000);
    } catch (error) {
        if (error.code !== "ENOENT") console.error("Could not load Solid-waddle memory:", error.message);
        return [];
    }
}

async function persistMemories(nextMemories) {
    const serialized = JSON.stringify(nextMemories, null, 2);
    memoryWriteQueue = memoryWriteQueue.catch(() => {}).then(async () => {
        const temporaryPath = memoryStorePath + ".tmp";
        await writeFile(temporaryPath, serialized, { mode: 0o600 });
        await rename(temporaryPath, memoryStorePath);
        savedMemories = nextMemories;
    });
    await memoryWriteQueue;
}

async function serveMemoryApi(request, response, requestUrl) {
    try {
        if (!isSameOriginRequest(request, request.method !== "GET")) {
            sendJson(response, 403, { error: "Cross-origin memory access is not allowed; writes require a same-origin request." });
            return;
        }
        if (requestUrl.pathname === "/api/memory" && request.method === "GET") {
            sendJson(response, 200, { memories: savedMemories });
            return;
        }
        const itemMatch = requestUrl.pathname.match(/^\/api\/memory\/([a-zA-Z0-9_-]{1,80})$/);
        if (request.method === "POST" && requestUrl.pathname === "/api/memory") {
            if (!request.headers["content-type"]?.startsWith("application/json")) {
                sendJson(response, 415, { error: "Memory writes require application/json." });
                return;
            }
            const body = await readJsonBody(request);
            const text = typeof body.text === "string" ? body.text.trim() : "";
            const category = memoryCategories.has(body.category) ? body.category : "fact";
            if (!text) {
                sendJson(response, 400, { error: "Memory text cannot be empty." });
                return;
            }
            if (text.length > 4000) {
                sendJson(response, 413, { error: "Memory text must be 4,000 characters or fewer." });
                return;
            }
            if (savedMemories.length >= 1000) {
                sendJson(response, 409, { error: "Memory is full (1,000 items). Delete an item before adding another." });
                return;
            }
            const now = new Date().toISOString();
            const memory = {
                id: "mem_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10),
                category,
                text,
                createdAt: now,
                updatedAt: now,
            };
            await persistMemories([memory, ...savedMemories]);
            sendJson(response, 201, { memory });
            return;
        }
        if (itemMatch && request.method === "PATCH") {
            if (!request.headers["content-type"]?.startsWith("application/json")) {
                sendJson(response, 415, { error: "Memory updates require application/json." });
                return;
            }
            const body = await readJsonBody(request);
            const old = savedMemories.find((item) => item.id === itemMatch[1]);
            if (!old) {
                sendJson(response, 404, { error: "Memory not found." });
                return;
            }
            const text = typeof body.text === "string" ? body.text.trim() : old.text;
            const category = memoryCategories.has(body.category) ? body.category : old.category;
            if (!text) {
                sendJson(response, 400, { error: "Memory text cannot be empty." });
                return;
            }
            if (text.length > 4000) {
                sendJson(response, 413, { error: "Memory text must be 4,000 characters or fewer." });
                return;
            }
            const memory = { ...old, text, category, updatedAt: new Date().toISOString() };
            await persistMemories(savedMemories.map((item) => item.id === old.id ? memory : item));
            sendJson(response, 200, { memory });
            return;
        }
        if (itemMatch && request.method === "DELETE") {
            const next = savedMemories.filter((item) => item.id !== itemMatch[1]);
            if (next.length === savedMemories.length) {
                sendJson(response, 404, { error: "Memory not found." });
                return;
            }
            await persistMemories(next);
            sendJson(response, 200, { ok: true });
            return;
        }
        if (request.method === "DELETE" && requestUrl.pathname === "/api/memory") {
            await persistMemories([]);
            sendJson(response, 200, { ok: true });
            return;
        }
        sendJson(response, 405, { error: "Unsupported memory method or route." });
    } catch (error) {
        sendJson(response, 500, { error: "Memory operation failed: " + error.message });
    }
}

async function startBrowserContainer() {
    if (!browserStartPromise) {
        browserStartPromise = execFileAsync("docker", ["compose", "up", "-d", "--wait"], {
            cwd: root,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
        }).then(() => undefined);
    }
    try {
        await browserStartPromise;
    } finally {
        browserStartPromise = null;
    }
}

async function serveBrowserApi(request, response, requestUrl) {
    try {
        if (!isSameOriginRequest(request)) {
            sendJson(response, 403, { error: "Cross-origin browser control is not allowed." });
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/browser/session") {
            await ensureWebdriverSession();
            sendJson(response, 200, { ready: true });
            return;
        }
        if (requestUrl.pathname === "/api/browser/state" && request.method === "GET") {
            const [url, title] = await Promise.all([
                webdriverRequest("GET", "url"),
                webdriverRequest("GET", "title"),
            ]);
            await rememberBrowserPage(url, title);
            sendJson(response, 200, { url, title });
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Use GET or POST for this browser action." });
            return;
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
            sendJson(response, 415, { error: "Browser commands require application/json." });
            return;
        }

        if (requestUrl.pathname === "/api/browser/start") {
            await startBrowserContainer();
            await ensureWebdriverSession();
            const currentUrl = await webdriverRequest("GET", "url");
            if (savedBrowserPage && isBlankBrowserPage(currentUrl)) {
                await webdriverRequest("POST", "url", { url: savedBrowserPage.url });
            }
        } else if (requestUrl.pathname === "/api/browser/navigate") {
            const body = await readJsonBody(request);
            const url = parseBrowserTarget(body.url || "");
            await webdriverRequest("POST", "url", { url });
            await rememberBrowserPage(url, "");
        } else if (requestUrl.pathname === "/api/browser/back") {
            await webdriverRequest("POST", "back", {});
        } else if (requestUrl.pathname === "/api/browser/forward") {
            await webdriverRequest("POST", "forward", {});
        } else if (requestUrl.pathname === "/api/browser/reload") {
            await webdriverRequest("POST", "refresh", {});
        } else {
            sendJson(response, 404, { error: "Unknown browser action." });
            return;
        }
        sendJson(response, 200, { ok: true });
    } catch (error) {
        sendJson(response, 502, { error: error.message });
    }
}

function proxyNoVnc(request, response) {
    if (!isSameOriginRequest(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Cross-origin remote desktop access is not allowed.");
        return;
    }
    request.url = request.url.replace(/^\/remote(?=\/|$)/, "") || "/";
    remoteProxy.web(request, response, (error) => {
        if (!response.headersSent) {
            response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            response.end(`Remote browser display unavailable: ${error.message}`);
        } else {
            response.destroy(error);
        }
    });
}

export function validateTarget(value) {
    const target = new URL(value);
    const hostname = target.hostname.toLowerCase();
    const allowed = allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (target.protocol !== "https:" || target.port || target.username || target.password || !allowed) {
        throw new Error("Only HTTPS URLs on approved OpenAI domains are allowed.");
    }
    return target;
}

export function makeFramingSafeHeaders(sourceHeaders) {
    const headers = new Headers(sourceHeaders);
    for (const name of [
        "x-frame-options",
        "set-cookie",
        "www-authenticate",
        "clear-site-data",
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "upgrade",
    ]) {
        headers.delete(name);
    }

    const policy = headers.get("content-security-policy");
    if (policy) {
        const directives = policy.split(";").map((directive) => directive.trim());
        const retained = directives.filter((directive) => !/^frame-ancestors(?:\s|$)/i.test(directive));
        if (retained.some(Boolean)) headers.set("content-security-policy", retained.join("; "));
        else headers.delete("content-security-policy");
    }
    return headers;
}

async function fetchAllowedPage(initialTarget, method, accept) {
    let target = validateTarget(initialTarget);
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        const response = await fetch(target, {
            method,
            headers: {
                accept: accept || "*/*",
                "user-agent": "Sideview-Iframe-Research/1.0",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
        });
        const location = response.headers.get("location");
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
        if (redirects === maxRedirects) throw new Error("The upstream page redirected too many times.");
        await response.body?.cancel();
        target = validateTarget(new URL(location, target).href);
    }
    throw new Error("Unable to resolve the upstream page.");
}

function sendDemo(response, proxied) {
    const headers = new Headers({
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    const outgoingHeaders = proxied ? makeFramingSafeHeaders(headers) : headers;
    outgoingHeaders.forEach((value, name) => response.setHeader(name, value));
    response.writeHead(200);
    response.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Frame policy demo</title><body style=\"font:16px sans-serif;padding:24px\"><h1>Local frame-policy demo</h1><p>This fixture is served by this project. No external site was requested.</p></body></html>");
}

function sendUpstreamDenied(response) {
    response.writeHead(403, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "cache-control": "no-store",
    });
    response.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Upstream access denied</title><body style=\"font:16px sans-serif;padding:24px\"><h1>Upstream access denied (HTTP 403)</h1><p>The server denied this request before the page could be displayed. Removing frame restrictions cannot resolve an upstream access denial.</p></body></html>");
}

async function serveProxy(request, response, requestUrl) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
        response.end("Only GET and HEAD are supported.");
        return;
    }
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget || rawTarget.length > 10000) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("A valid target URL is required.");
        return;
    }

    let target;
    try {
        target = validateTarget(rawTarget);
    } catch (error) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end(error.message);
        return;
    }

    try {
        const upstream = await fetchAllowedPage(target, request.method, request.headers.accept);
        const declaredLength = Number(upstream.headers.get("content-length"));
        if (upstream.status === 403) {
            await upstream.body?.cancel();
            sendUpstreamDenied(response);
            return;
        }
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
            await upstream.body?.cancel();
            response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
            response.end("The upstream response is larger than the 15 MB limit.");
            return;
        }

        const headers = makeFramingSafeHeaders(upstream.headers);
        headers.set("cache-control", "no-store");
        headers.forEach((value, name) => response.setHeader(name, value));
        response.writeHead(upstream.status);
        if (request.method === "HEAD" || !upstream.body) {
            response.end();
            return;
        }

        let transferred = 0;
        const sizeLimit = new Transform({
            transform(chunk, encoding, callback) {
                transferred += chunk.length;
                if (transferred > maxResponseBytes) callback(new Error("Upstream response exceeded the 15 MB limit."));
                else callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(upstream.body), sizeLimit, response);
    } catch (error) {
        if (!response.headersSent) {
            response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
            response.end(error.message);
        } else {
            response.destroy(error);
        }
    }
}

function serveProxyView(response, requestUrl) {
    try {
        const target = validateTarget(requestUrl.searchParams.get("url") || "");
        const frameUrl = `/proxy?url=${encodeURIComponent(target.href)}`;
        response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'",
            "x-frame-options": "SAMEORIGIN",
            "cache-control": "no-store",
        });
        response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sideview proxy view</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{overflow:hidden}</style><iframe title="Sandboxed proxy view" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${frameUrl}"></iframe></html>`);
    } catch (error) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end(error.message);
    }
}

const demoHtml = await readFile(path.join(root, "index.html"));
const desktopHtml = await readFile(path.join(root, "desktop.html"));
const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    if (requestUrl.pathname === "/remote" || requestUrl.pathname.startsWith("/remote/")) {
        proxyNoVnc(request, response);
    } else if (requestUrl.pathname === "/api/memory" || requestUrl.pathname.startsWith("/api/memory/")) {
        await serveMemoryApi(request, response, requestUrl);
    } else if (requestUrl.pathname.startsWith("/api/browser/")) {
        await serveBrowserApi(request, response, requestUrl);
    } else if (requestUrl.pathname === "/proxy") {
        await serveProxy(request, response, requestUrl);
    } else if (requestUrl.pathname === "/proxy-view") {
        serveProxyView(response, requestUrl);
    } else if (requestUrl.pathname === "/demo/blocked") {
        sendDemo(response, false);
    } else if (requestUrl.pathname === "/demo/proxy-preview") {
        sendDemo(response, true);
    } else if (requestUrl.pathname === "/demo/upstream-denied") {
        sendUpstreamDenied(response);
    } else if (requestUrl.pathname === "/" || requestUrl.pathname === "/desktop") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(desktopHtml);
    } else if (requestUrl.pathname === "/browser" || requestUrl.pathname === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(demoHtml);
    } else if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
    } else {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found.");
    }
});

server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if ((pathname !== "/remote" && !pathname.startsWith("/remote/")) || !isSameOriginRequest(request, true)) {
        socket.destroy();
        return;
    }
    request.url = request.url.replace(/^\/remote(?=\/|$)/, "") || "/";
    remoteProxy.ws(request, socket, head, { target: "ws://127.0.0.1:7900" });
});

server.on("connect", (request, socket, head) => {
    handleBrowserConnect(request, socket, head).catch((error) => {
        if (!socket.destroyed) rejectTunnel(socket, 502, `Tunnel setup failed: ${error.message}`);
    });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT || 8000);
    const host = process.env.HOST || "0.0.0.0";
    server.listen(port, host, () => {
        process.stdout.write(`Sideview proxy listening on http://${host}:${port}\n`);
    });
}