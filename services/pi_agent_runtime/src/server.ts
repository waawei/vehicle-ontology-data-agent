import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadRuntimeConfig, publicConfig, type RuntimeConfig } from "./config.js";
import { OntologyCatalog, type OntologyKind } from "./ontology.js";
import { PiVehicleRuntime, RuntimeHttpError } from "./runtime.js";
import { PrincipalResolutionError, PrincipalResolver, type ThreadOwner } from "./principal.js";
import { StoreError, ThreadStore } from "./store.js";
import { workspaceSnapshot } from "./workspace.js";

const config = loadRuntimeConfig();
const store = new ThreadStore(config.dataDir);
await store.initialize();
const ontology = await OntologyCatalog.load(config.semanticIndexPath);
const runtime = new PiVehicleRuntime(config, store, ontology);
const principalResolver = new PrincipalResolver(config.agentApiUrl);

const server = createServer(async (request, response) => {
  applyCors(request, response, config);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  try {
    await route(request, response);
  } catch (error) {
    const normalized = normalizeError(error);
    sendJson(response, normalized.statusCode, {
      error: { code: normalized.code, message: normalized.message },
    });
  }
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${config.host}:${config.port}`);
  if (request.method === "GET" && url.pathname === "/health/live") {
    sendJson(response, 200, { status: "ok", runtime: "pi-agent-core" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health/ready") {
    const ready = Boolean(config.apiKey && config.modelId);
    sendJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
      keyConfigured: Boolean(config.apiKey),
      modelConfigured: Boolean(config.modelId),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/config") {
    sendJson(response, 200, publicConfig(config));
    return;
  }
  if (request.method === "GET" && url.pathname === "/workspace") {
    await resolveOwner(request);
    sendJson(response, 200, workspaceSnapshot(config, ontology));
    return;
  }
  if (request.method === "GET" && url.pathname === "/ontology") {
    await resolveOwner(request);
    const kind = ontologyKind(url.searchParams.get("kind"));
    const query = url.searchParams.get("query") || "";
    sendJson(response, 200, ontology.view(query, kind));
    return;
  }
  const threadRoute = url.pathname === "/threads" || url.pathname.startsWith("/threads/");
  const owner = threadRoute ? await resolveOwner(request) : undefined;
  if (request.method === "GET" && url.pathname === "/threads") {
    const state = threadListState(url.searchParams.get("state"));
    const threads = await store.list(owner, state);
    sendJson(
      response,
      200,
      threads.map(({ messages, events, ownerKind, principalId, tenantId, ...thread }) => ({
        ...thread,
        messageCount: messages.length,
        eventCount: events.length,
      })),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/threads") {
    const body = await jsonBody(request);
    const title = typeof body.title === "string" ? body.title : undefined;
    const thread = await store.create(title, owner);
    sendJson(response, 201, publicThread(thread));
    return;
  }
  const threadMatch = /^\/threads\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (request.method === "GET" && threadMatch?.[1]) {
    sendJson(response, 200, publicThread(await store.get(threadMatch[1], owner)));
    return;
  }
  if (request.method === "PATCH" && threadMatch?.[1]) {
    const body = await jsonBody(request);
    const fields = Object.keys(body);
    const field = fields[0];
    if (fields.length !== 1 || !field || !new Set(["archived", "pinned", "title"]).has(field)) {
      throw new RuntimeHttpError(
        "THREAD_UPDATE_INVALID",
        "Exactly one of archived, pinned, or title must be provided",
        422,
      );
    }
    let thread;
    if (field === "archived") {
      if (typeof body.archived !== "boolean") {
        throw new RuntimeHttpError("THREAD_UPDATE_INVALID", "archived must be a boolean", 422);
      }
      thread = await store.setArchived(threadMatch[1], body.archived, owner);
    } else if (field === "pinned") {
      if (typeof body.pinned !== "boolean") {
        throw new RuntimeHttpError("THREAD_UPDATE_INVALID", "pinned must be a boolean", 422);
      }
      thread = await store.setPinned(threadMatch[1], body.pinned, owner);
    } else {
      if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
        throw new RuntimeHttpError("THREAD_UPDATE_INVALID", "title must contain 1 to 160 characters", 422);
      }
      thread = await store.rename(threadMatch[1], body.title, owner);
    }
    sendJson(response, 200, publicThread(thread));
    return;
  }
  if (request.method === "DELETE" && threadMatch?.[1]) {
    await store.remove(threadMatch[1], owner);
    response.writeHead(204).end();
    return;
  }
  const promptMatch = /^\/threads\/([a-f0-9-]{36})\/messages$/.exec(url.pathname);
  if (request.method === "POST" && promptMatch?.[1]) {
    const body = await jsonBody(request);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 20_000) {
      throw new RuntimeHttpError("MESSAGE_INVALID", "Message content is required", 422);
    }
    const result = await runtime.prompt(
      promptMatch[1],
      content,
      request.headers.cookie || "",
      owner,
    );
    sendJson(response, 200, result);
    return;
  }
  throw new RuntimeHttpError("NOT_FOUND", "Route not found", 404);
}

function applyCors(request: IncomingMessage, response: ServerResponse, active: RuntimeConfig): void {
  const origin = request.headers.origin?.replace(/\/$/, "");
  if (origin && active.corsOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
  }
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,x-request-id,x-csrf-token,x-pi-agent-client");
}

async function resolveOwner(request: IncomingMessage): Promise<ThreadOwner> {
  const cookie = request.headers.cookie || "";
  const client = String(request.headers["x-pi-agent-client"] || "").toLowerCase();
  if (!cookie.trim()) {
    if (client === "tui") return { kind: "legacy" };
    throw new RuntimeHttpError("UNAUTHENTICATED", "Authentication is required", 401);
  }

  const principal = await principalResolver.resolve(cookie);
  if (client !== "tui" && request.method !== "GET") {
    const cookies = parseCookies(cookie);
    const csrf = request.headers["x-csrf-token"];
    if (!cookies.r6_csrf || typeof csrf !== "string" || csrf !== cookies.r6_csrf) {
      throw new RuntimeHttpError("CSRF_FAILED", "CSRF validation failed", 403);
    }
  }
  return {
    kind: "principal",
    principalId: principal.principalId,
    ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
  };
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index < 1) return [];
      return [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
    }),
  );
}

function ontologyKind(value: string | null): OntologyKind | undefined {
  if (value === null || value === "") return undefined;
  if (new Set(["metric", "entity", "event", "field", "relation", "time"]).has(value)) return value as OntologyKind;
  throw new RuntimeHttpError("ONTOLOGY_KIND_INVALID", "Ontology kind is invalid", 422);
}

function threadListState(value: string | null): "active" | "archived" | "all" {
  if (value === null || value === "" || value === "active") return "active";
  if (value === "archived" || value === "all") return value;
  throw new RuntimeHttpError("THREAD_STATE_INVALID", "Thread state is invalid", 422);
}

function publicThread(thread: Awaited<ReturnType<ThreadStore["get"]>>): Record<string, unknown> {
  const { ownerKind, principalId, tenantId, ...publicValue } = thread;
  return publicValue;
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 64 * 1024) throw new RuntimeHttpError("REQUEST_TOO_LARGE", "Request body is too large", 413);
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RuntimeHttpError("JSON_INVALID", "Request body must be a JSON object", 422);
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function normalizeError(error: unknown): RuntimeHttpError {
  if (error instanceof RuntimeHttpError) return error;
  if (error instanceof StoreError) return new RuntimeHttpError(error.code, error.message, error.statusCode);
  if (error instanceof PrincipalResolutionError) {
    return new RuntimeHttpError(error.code, error.message, error.statusCode);
  }
  const message = error instanceof Error ? error.message : "Unexpected runtime error";
  return new RuntimeHttpError("INTERNAL_ERROR", message.slice(0, 500), 500);
}

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: "pi_agent_runtime.started",
      host: config.host,
      port: config.port,
      ...publicConfig(config),
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
