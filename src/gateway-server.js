import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RuntimeSession } from "./runtime-session.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = path.resolve(sourceDirectory, "..", "web");
const MAX_JSON_BYTES = 128 * 1024;
const MAX_TURN_CHARS = 100_000;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]]
]);

function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function requestHostAllowed(request, allowedHosts) {
  const raw = String(request.headers.host ?? "").toLowerCase();
  const host = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  return allowedHosts.has(host);
}

function requestOriginAllowed(request) {
  if (String(request.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const requestHost = String(request.headers.host ?? "").toLowerCase();
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

async function readJson(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) {
      throw Object.assign(new Error("JSON request body is too large"), { status: 413, code: "BODY_TOO_LARGE" });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400, code: "INVALID_JSON" });
  }
}

function validateProjectRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("projectRoot is required"), { status: 400, code: "INVALID_PROJECT_ROOT" });
  }
  const resolved = path.resolve(value.trim());
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw Object.assign(new Error("projectRoot does not exist"), { status: 400, code: "INVALID_PROJECT_ROOT" });
  }
  if (!stats.isDirectory()) {
    throw Object.assign(new Error("projectRoot must be a directory"), { status: 400, code: "INVALID_PROJECT_ROOT" });
  }
  return fs.realpathSync.native(resolved);
}

function writeSse(response, record) {
  response.write(`id: ${record.id}\nevent: ${record.type}\ndata: ${JSON.stringify({ timestamp: record.timestamp, ...record.data })}\n\n`);
}

export function createGatewayServer({
  runtimeFactory,
  client,
  defaultProjectRoot,
  webRoot = defaultWebRoot,
  approvalTimeoutMs,
  maxSessions = 8,
  allowedHosts = ["127.0.0.1", "localhost", "[::1]"]
}) {
  if (typeof runtimeFactory !== "function") throw new Error("runtimeFactory is required");
  if (!client || typeof client.health !== "function" || typeof client.models !== "function") {
    throw new Error("A shared LlamaClient-compatible client is required");
  }
  const sessions = new Map();
  const sseClients = new Set();
  const acceptedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(response, error.status ?? 500, error.code ?? "INTERNAL_ERROR", error.status ? error.message : "Internal gateway error");
    });
  });

  async function handleRequest(request, response) {
    if (!requestHostAllowed(request, acceptedHosts)) return sendError(response, 421, "INVALID_HOST", "Host is not allowed");
    if (!requestOriginAllowed(request)) return sendError(response, 403, "CROSS_SITE_REQUEST", "Cross-site requests are not allowed");
    const url = new URL(request.url ?? "/", "http://localhost");

    if ((request.method === "GET" || request.method === "HEAD") && STATIC_FILES.has(url.pathname)) {
      const [name, contentType] = STATIC_FILES.get(url.pathname);
      const body = fs.readFileSync(path.join(webRoot, name));
      response.writeHead(200, {
        ...securityHeaders(contentType),
        "cache-control": "no-cache",
        "content-length": body.length
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return sendJson(response, 200, { apiVersion: 1, defaultProjectRoot, maxSessions });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      try {
        const [health, models] = await Promise.all([client.health(), client.models()]);
        return sendJson(response, 200, { status: "ready", llama: health, models: models.data?.map((model) => model.id) ?? [] });
      } catch (error) {
        return sendJson(response, 503, { status: "offline", error: error.message });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      if (sessions.size >= maxSessions) return sendError(response, 429, "SESSION_LIMIT", "Gateway session limit reached");
      const body = await readJson(request);
      const projectRoot = validateProjectRoot(body.projectRoot ?? defaultProjectRoot);
      if ([...sessions.values()].some((session) => path.resolve(session.projectRoot) === path.resolve(projectRoot))) {
        return sendError(response, 409, "PROJECT_SESSION_ACTIVE", "This project already has an active Gateway session");
      }
      const id = randomUUID();
      const session = new RuntimeSession({ id, projectRoot, runtimeFactory, approvalTimeoutMs });
      try {
        const status = typeof session.runtime.checkHealth === "function" ? await session.runtime.checkHealth() : null;
        sessions.set(id, session);
        return sendJson(response, 201, { session: session.snapshot(), runtime: status });
      } catch (error) {
        session.close();
        return sendError(response, 503, "LLAMA_SERVER_OFFLINE", error.message);
      }
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)$/i);
    if (sessionMatch && request.method === "GET") {
      const session = sessions.get(sessionMatch[1]);
      return session ? sendJson(response, 200, { session: session.snapshot() }) : sendError(response, 404, "SESSION_NOT_FOUND", "Session not found");
    }
    if (sessionMatch && request.method === "DELETE") {
      const session = sessions.get(sessionMatch[1]);
      if (!session) return sendError(response, 404, "SESSION_NOT_FOUND", "Session not found");
      session.close();
      sessions.delete(session.id);
      response.writeHead(204, securityHeaders("application/json; charset=utf-8"));
      response.end();
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/events$/i);
    if (eventsMatch && request.method === "GET") {
      const session = sessions.get(eventsMatch[1]);
      if (!session) return sendError(response, 404, "SESSION_NOT_FOUND", "Session not found");
      response.writeHead(200, {
        ...securityHeaders("text/event-stream; charset=utf-8"),
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });
      sseClients.add(response);
      response.write("retry: 2000\n\n");
      const afterEventId = Number.parseInt(String(request.headers["last-event-id"] ?? "0"), 10) || 0;
      let unsubscribe = () => {};
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseClients.delete(response);
      };
      unsubscribe = session.subscribe((record) => {
        writeSse(response, record);
        if (record.type === "session_closed") setImmediate(() => {
          cleanup();
          response.end();
        });
      }, { afterEventId });
      const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
      heartbeat.unref?.();
      request.on("close", cleanup);
      return;
    }

    const turnMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/turn$/i);
    if (turnMatch && request.method === "POST") {
      const session = sessions.get(turnMatch[1]);
      if (!session) return sendError(response, 404, "SESSION_NOT_FOUND", "Session not found");
      if (session.busy) return sendError(response, 409, "SESSION_BUSY", "A turn is already running");
      const body = await readJson(request);
      if (typeof body.content !== "string" || !body.content.trim()) return sendError(response, 400, "INVALID_TURN", "content is required");
      if (body.content.length > MAX_TURN_CHARS) return sendError(response, 413, "TURN_TOO_LARGE", "Turn content is too large");
      try {
        const result = await session.runTurn(body.content.trim());
        return sendJson(response, 200, { status: "complete", content: result?.content ?? "", usage: result?.usage ?? null });
      } catch (error) {
        return sendError(response, 500, "TURN_FAILED", error.message);
      }
    }

    const approvalMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/approvals\/([0-9a-f-]+)$/i);
    if (approvalMatch && request.method === "POST") {
      const session = sessions.get(approvalMatch[1]);
      if (!session) return sendError(response, 404, "SESSION_NOT_FOUND", "Session not found");
      const body = await readJson(request);
      if (typeof body.approved !== "boolean") return sendError(response, 400, "INVALID_APPROVAL", "approved must be boolean");
      if (!session.resolveApproval(approvalMatch[2], body.approved)) {
        return sendError(response, 404, "APPROVAL_NOT_FOUND", "Approval is no longer pending");
      }
      return sendJson(response, 200, { approvalId: approvalMatch[2], approved: body.approved });
    }

    sendError(response, 404, "NOT_FOUND", "Route not found");
  }

  return {
    server,
    sessions,
    listen({ host = "127.0.0.1", port = 8787 } = {}) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
      for (const response of sseClients) response.end();
      sseClients.clear();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
