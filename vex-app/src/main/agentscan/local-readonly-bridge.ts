/**
 * Browser-to-Vex read-only presence bridge for AgentScan.
 *
 * This is deliberately a tiny, loopback-only capability surface. It exposes a
 * sanitized subset of the static Studio MCP inventory and nothing else: no
 * project records, wallet identifiers, tool inputs, memory, database state, or
 * execution route. The listener stays up for the Vex app lifetime; lock and
 * readiness are per-request admission gates that return typed 423 responses.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type {
  AgentscanImportIntentRegistry,
  ImportIntentCreateInput,
} from "./import-intents.js";
import { agentScanManifestSchema, type AgentScanManifest } from "@shared/schemas/agentscan-import.js";
import { publicationRequestSchema, type PublicationRequest } from "@shared/schemas/agentscan-publication.js";
import { localPublicationLaunchRequestSchema } from "@shared/schemas/agentscan-publication.js";
import type { PublicationIntentRegistry } from "./publication-intents.js";

export const AGENTSCAN_LOCAL_BRIDGE_PORT = 47_831;
export const AGENTSCAN_LOCAL_BRIDGE_HOST = "127.0.0.1";
export const AGENTSCAN_CONNECTOR_HEADER = "vex-readonly-agent";

export const AGENTSCAN_PRODUCTION_ORIGINS: ReadonlySet<string> = new Set([
  "https://agentscan-v7-1-clickable-demo.vercel.app",
]);

export const AGENTSCAN_DEVELOPMENT_ORIGINS: ReadonlySet<string> = new Set([
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:3011",
  "http://127.0.0.1:3011",
]);

const MARKET_READ_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "pools__launch_assets_list",
  "pools__token_candles_list",
  "pools__token_get",
  "pools__tokens_discover",
  "pools__tokens_search",
  "virtuals__agent_candles_list",
  "virtuals__agent_get",
  "virtuals__agent_launch_status",
  "virtuals__agent_trade_quote",
  "virtuals__agent_trades_list",
  "virtuals__agents_discover",
  "virtuals__genesis_launches_list",
  "virtuals__graduations_list",
]);

const MAX_REQUEST_BODY_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 5_000;
const INVENTORY_TIMEOUT_MS = 2_000;
const MAX_CONNECTIONS = 16;

export interface AgentscanInventoryTool {
  readonly publicName: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
  };
}

export interface AgentscanLocalBridgeOptions {
  readonly port?: number;
  readonly inventoryTimeoutMs?: number;
  readonly allowedOrigins?: ReadonlySet<string>;
  readonly isAvailable: () => boolean;
  readonly readInventory?: () => Promise<readonly AgentscanInventoryTool[]>;
  readonly logInfo?: (message: string) => void;
  readonly logWarn?: (message: string) => void;
  /** Optional metadata-only import capability, owned by the main process. */
  readonly importIntents?: AgentscanImportIntentRegistry;
  /** Optional metadata-only publication capability, owned by main. */
  readonly publicationIntents?: PublicationIntentRegistry;
}

export interface AgentscanLocalBridgeStart {
  readonly started: boolean;
  readonly port: number | null;
  readonly reason?: "unavailable" | "bind_failed" | "stopped";
}

export interface AgentscanLocalBridge {
  start(): Promise<AgentscanLocalBridgeStart>;
  stop(): Promise<void>;
  /** Rotate the ephemeral browser capability after an admission transition. */
  rotateCapabilityToken(): void;
  port(): number | null;
}

interface SanitizedTool {
  readonly name: string;
  readonly readOnlyHint: true;
}

type InventoryReader = () => Promise<readonly AgentscanInventoryTool[]>;

const defaultInventoryReader: InventoryReader = async () => {
  // Keep the engine registry out of Electron main's eager static graph, like
  // the Studio executor loader. The inventory itself is static and read-only.
  const { buildStudioInventory } = await import("@vex-agent/mcp/inventory/index.js");
  return buildStudioInventory();
};

export function agentscanAllowedOrigins(includeDevelopment: boolean): ReadonlySet<string> {
  return includeDevelopment
    ? new Set([...AGENTSCAN_PRODUCTION_ORIGINS, ...AGENTSCAN_DEVELOPMENT_ORIGINS])
    : AGENTSCAN_PRODUCTION_ORIGINS;
}

/** Exact-origin decision. No suffix matching and no renderer-supplied origin. */
export function isAllowedAgentscanOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): origin is string {
  return origin !== undefined && allowedOrigins.has(origin);
}

/**
 * DNS-rebinding guard for the HTTP Host header. The listener is loopback-only,
 * and requests must also address it as loopback rather than through a hostname
 * controlled by a web page.
 */
export function isAllowedLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `${AGENTSCAN_LOCAL_BRIDGE_HOST}:${String(port)}`;
}

export function isAllowedPrivateNetworkPreflight(
  value: string | string[] | undefined,
  origin?: string,
  allowedOrigins: ReadonlySet<string> = AGENTSCAN_PRODUCTION_ORIGINS,
): boolean {
  if (value === "true") return true;
  // Current Chrome Local Network Access requests may omit the legacy PNA
  // header. Exact origin allowlisting remains mandatory and a literal false
  // value is still rejected.
  return value === undefined
    && origin !== undefined
    && allowedOrigins.has(origin);
}

/** Strict browser request parser; unknown fields are rejected before ownership logic. */
export function parseAgentscanImportRequest(
  body: unknown,
): Pick<ImportIntentCreateInput, "idempotencyKey" | "manifestDigest" | "manifest"> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4
    || candidate.schema !== "agentscan.vex.import-request/1"
    || typeof candidate.idempotencyKey !== "string"
    || candidate.idempotencyKey.length < 1
    || candidate.idempotencyKey.length > 256
    || typeof candidate.manifestDigest !== "string"
  ) return null;
  const parsedManifest = agentScanManifestSchema.safeParse(candidate.manifest);
  if (!parsedManifest.success) return null;
  return {
    idempotencyKey: candidate.idempotencyKey,
    manifestDigest: candidate.manifestDigest,
    manifest: parsedManifest.data as AgentScanManifest,
  };
}

export function sanitizeAgentscanTools(
  inventory: readonly AgentscanInventoryTool[],
): readonly SanitizedTool[] {
  const seen = new Set<string>();
  const tools: SanitizedTool[] = [];
  for (const tool of inventory) {
    if (!MARKET_READ_TOOL_ALLOWLIST.has(tool.publicName) || seen.has(tool.publicName)) continue;
    if (tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint !== false) continue;
    seen.add(tool.publicName);
    tools.push({
      name: tool.publicName,
      readOnlyHint: true,
    });
  }
  return tools;
}

function snapshotFor(tools: readonly SanitizedTool[], intentToken?: string): Record<string, unknown> {
  const toolHash = `sha256:${createHash("sha256")
    .update(tools.map((tool) => tool.name).join("\n"))
    .digest("hex")}`;
  return {
    schema: "agentscan.vex.snapshot/1",
    provider: "vex-studio",
    mode: "read-only",
    localOnly: true,
    projectRef: null,
    bridge: {
      connected: true,
      serverName: "vex-desktop",
      protocolVersion: "agentscan-local/1",
      ...(intentToken === undefined ? {} : { intentToken }),
    },
    tools,
    readOnlyToolCount: tools.length,
    toolHash,
    syncContract: {
      schema: "agentscan.vex.sync-contract/1",
      link: {
        state: "studio_ready",
        projectRef: null,
        projectIdExposed: false,
        nextAction: "select_project_in_vex_studio",
      },
      project: {
        state: "selection_required",
        enumeration: "unavailable",
        name: null,
        revision: null,
      },
      capabilities: {
        readOnlyMarketData: tools.length > 0,
        importPlan: "requires_local_project_selection",
        deployPlan: "blocked",
        signing: false,
        execution: false,
      },
      importPlan: {
        version: "1",
        state: "project_selection_required",
        action: "select_project_in_vex_studio",
        executable: false,
        requiresUserApproval: true,
      },
      deployPlan: {
        version: "1",
        state: "blocked",
        action: "review_in_vex_studio",
        executable: false,
        signable: false,
        requiresUserApproval: true,
      },
    },
    receipt: {
      id: `vex_ro_${toolHash.slice(7, 19)}`,
      kind: "sanitized-read-only-capability",
      source: "VEX Studio",
      projectRef: null,
      projectIdsExposed: false,
      databaseAccessed: false,
      personalMemoryAccessed: false,
      mutationToolsExecuted: 0,
      walletAccessed: false,
    },
  };
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader(
    "Vary",
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function requestedHeadersAreAllowed(value: string | undefined, importRoute = false): boolean {
  if (value === undefined) return false;
  const requested = new Set(value.toLowerCase().split(",").map((item) => item.trim()));
  const required = ["content-type", "x-agentscan-connector"];
  if (importRoute) required.push("x-agentscan-session");
  return requested.size === required.length && required.every((header) => requested.has(header));
}

const MAX_IMPORT_BODY_BYTES = 256 * 1024;

async function readJsonBody(request: IncomingMessage): Promise<unknown | "invalid" | "too_large"> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BODY_BYTES) {
    request.resume();
    return "too_large";
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_IMPORT_BODY_BYTES) {
      request.resume();
      return "too_large";
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return "invalid";
  }
}

function parsePublicationRequest(body: unknown): PublicationRequest | null {
  const parsed = publicationRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

function parseLocalPublicationLaunch(body: unknown): string | null {
  const parsed = localPublicationLaunchRequestSchema.safeParse(body);
  return parsed.success ? parsed.data.idempotencyKey : null;
}

async function readInventoryBeforeDeadline(
  readInventory: InventoryReader,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<readonly AgentscanInventoryTool[] | null> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
    timeout.unref();
  });
  try {
    const result = await Promise.race([readInventory(), deadline]);
    if (result === null) onTimeout?.();
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readEmptyJsonObject(request: IncomingMessage): Promise<"ok" | "invalid" | "too_large"> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    request.resume();
    return "too_large";
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      return "too_large";
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return "invalid";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalid";
  return Object.keys(parsed).length === 0 ? "ok" : "invalid";
}

export function createAgentscanLocalBridge(options: AgentscanLocalBridgeOptions): AgentscanLocalBridge {
  const configuredPort = options.port ?? AGENTSCAN_LOCAL_BRIDGE_PORT;
  const allowedOrigins = options.allowedOrigins ?? AGENTSCAN_PRODUCTION_ORIGINS;
  const readInventory = options.readInventory ?? defaultInventoryReader;
  const inventoryTimeoutMs = options.inventoryTimeoutMs ?? INVENTORY_TIMEOUT_MS;
  const logInfo = options.logInfo ?? (() => undefined);
  const logWarn = options.logWarn ?? (() => undefined);

  let server: Server | null = null;
  let starting: Promise<AgentscanLocalBridgeStart> | null = null;
  // A new token is minted for every listener lifetime. It is never persisted,
  // and stop/restart invalidates all browser-held import capability.
  let intentToken: string | null = null;
  let inventoryReadInFlight: Promise<readonly AgentscanInventoryTool[]> | null = null;
  let lifecycle = 0;
  const sockets = new Set<Socket>();

  const readInventoryShared = (): Promise<readonly AgentscanInventoryTool[]> => {
    if (inventoryReadInFlight !== null) return inventoryReadInFlight;
    const pending = Promise.resolve().then(readInventory);
    inventoryReadInFlight = pending;
    void pending.then(
      () => {
        if (inventoryReadInFlight === pending) inventoryReadInFlight = null;
      },
      () => {
        if (inventoryReadInFlight === pending) inventoryReadInFlight = null;
      },
    );
    return pending;
  };

  const currentPort = (): number | null => {
    const address = server?.address();
    return address !== null && typeof address === "object" ? address.port : null;
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applySecurityHeaders(response);
    const port = currentPort();
    if (port === null || !isAllowedLoopbackHost(request.headers.host, port)) {
      sendJson(response, 421, { error: "loopback_host_required" });
      return;
    }

    const origin = request.headers.origin;
    const originAllowed = isAllowedAgentscanOrigin(origin, allowedOrigins);
    if (originAllowed) response.setHeader("Access-Control-Allow-Origin", origin);

    const requestUrl = request.url ?? "/";
    const importRoute = requestUrl === "/v1/import-intents"
      || /^\/v1\/import-intents\/[^/]+\/status$/u.test(requestUrl);
    const publicationRoute = requestUrl === "/v1/publication-intents"
      || /^\/v1\/publication-intents\/[^/]+\/status$/u.test(requestUrl);
    const localPublicationRoute = requestUrl === "/v1/local-agent-publications"
      || /^\/v1\/local-agent-publications\/[^/]+\/status$/u.test(requestUrl);
    const capabilityRoute = importRoute || publicationRoute || localPublicationRoute;

    if (request.method === "OPTIONS") {
      if (
        (requestUrl !== "/v1/snapshot" && !capabilityRoute)
        || !originAllowed
        || request.headers["access-control-request-method"] !== "POST"
        || !requestedHeadersAreAllowed(request.headers["access-control-request-headers"], capabilityRoute)
        || !isAllowedPrivateNetworkPreflight(
          request.headers["access-control-request-private-network"],
          origin,
          allowedOrigins,
        )
      ) {
        sendJson(response, 403, { error: "preflight_not_allowed" });
        return;
      }
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        capabilityRoute
          ? "content-type, x-agentscan-connector, x-agentscan-session"
          : "content-type, x-agentscan-connector",
      );
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.setHeader("Access-Control-Max-Age", "600");
      response.writeHead(204).end();
      return;
    }

    if (requestUrl !== "/v1/snapshot" && !capabilityRoute) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (!originAllowed) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (request.headers["x-agentscan-connector"] !== AGENTSCAN_CONNECTOR_HEADER) {
      sendJson(response, 400, { error: "connector_header_required" });
      return;
    }
    if (importRoute && options.importIntents === undefined) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (publicationRoute && options.publicationIntents === undefined) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (localPublicationRoute && options.publicationIntents === undefined) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    // Admission precedes session/body handling so a locked or unready Vex
    // consistently reports typed unavailability without revealing capability
    // state or accepting a stale browser token.
    if (!options.isAvailable()) {
      sendJson(response, 423, { error: "vex_locked_or_starting" });
      return;
    }
    if (capabilityRoute && request.headers["x-agentscan-session"] !== intentToken) {
      sendJson(response, 401, { error: "agentscan_session_required" });
      return;
    }
    const contentType = String(request.headers["content-type"] ?? "")
      .toLowerCase()
      .split(";", 1)[0]
      ?.trim();
    if (contentType !== "application/json") {
      sendJson(response, 415, { error: "application_json_required" });
      return;
    }
    if (capabilityRoute) {
      const body = await readJsonBody(request);
      if (body === "too_large") {
        sendJson(response, 413, { error: "payload_too_large" });
        return;
      }
      if (body === "invalid" || typeof body !== "object" || body === null || Array.isArray(body)) {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
      const intents = options.importIntents;
      const publications = options.publicationIntents;
      if ((publicationRoute || localPublicationRoute) && publications !== undefined) {
        if (localPublicationRoute) {
          if (requestUrl === "/v1/local-agent-publications") {
            const idempotencyKey = parseLocalPublicationLaunch(body);
            if (idempotencyKey === null) { sendJson(response, 400, { error: "invalid_local_publication_launch" }); return; }
            const result = publications.createLocal(origin, idempotencyKey);
            if (!result.ok) {
              sendJson(response, result.reason === "idempotency_collision" ? 409 : 429, { error: result.reason });
              return;
            }
            sendJson(response, result.replay ? 200 : 201, result.data);
            return;
          }
          const match = /^\/v1\/local-agent-publications\/([^/]+)\/status$/u.exec(requestUrl);
          if (match === null || match[1] === undefined) { sendJson(response, 404, { error: "not_found" }); return; }
          let intentId: string;
          try { intentId = decodeURIComponent(match[1]); } catch { sendJson(response, 400, { error: "invalid_intent_id" }); return; }
          if (Object.keys(body).length !== 0) { sendJson(response, 400, { error: "empty_json_object_required" }); return; }
          const status = publications.status(intentId);
          if (status === null) { sendJson(response, 404, { error: "not_found" }); return; }
          sendJson(response, 200, status);
          return;
        }
        if (requestUrl === "/v1/publication-intents") {
          const parsed = parsePublicationRequest(body);
          if (parsed === null) { sendJson(response, 400, { error: "invalid_publication_request" }); return; }
          const result = publications.create(origin, parsed);
          if (!result.ok) {
            sendJson(response, result.reason === "idempotency_collision" ? 409 : result.reason === "pending_bound" ? 429 : 400, { error: result.reason });
            return;
          }
          sendJson(response, result.replay ? 200 : 201, result.data);
          return;
        }
        const match = /^\/v1\/publication-intents\/([^/]+)\/status$/u.exec(requestUrl);
        if (match === null || match[1] === undefined) { sendJson(response, 404, { error: "not_found" }); return; }
        let intentId: string;
        try { intentId = decodeURIComponent(match[1]); } catch { sendJson(response, 400, { error: "invalid_intent_id" }); return; }
        if (Object.keys(body).length !== 0) { sendJson(response, 400, { error: "empty_json_object_required" }); return; }
        const status = publications.status(intentId);
        if (status === null) { sendJson(response, 404, { error: "not_found" }); return; }
        sendJson(response, 200, status);
        return;
      }
      if (intents === undefined) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (requestUrl === "/v1/import-intents") {
        const sourceOrigin = origin;
        const parsed = parseAgentscanImportRequest(body);
        if (parsed === null) {
          sendJson(response, 400, { error: "invalid_import_request" });
          return;
        }
        const result = intents.create({
          ...parsed,
          sourceOrigin,
        });
        if (!result.ok) {
          const status = result.reason === "idempotency_collision" ? 409
            : result.reason === "pending_bound" ? 429
              : result.reason === "invalid_request" ? 400 : 401;
          sendJson(response, status, { error: result.reason });
          return;
        }
        sendJson(response, result.replay ? 200 : 201, result.data);
        return;
      }
      const match = /^\/v1\/import-intents\/([^/]+)\/status$/u.exec(requestUrl);
      if (match === null) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const rawIntentId = match[1];
      if (rawIntentId === undefined) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (Object.keys(body).length !== 0) {
        sendJson(response, 400, { error: "empty_json_object_required" });
        return;
      }
      let intentId: string;
      try {
        intentId = decodeURIComponent(rawIntentId);
      } catch {
        sendJson(response, 400, { error: "invalid_intent_id" });
        return;
      }
      const result = intents.status(intentId);
      if (!result.ok) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      sendJson(response, 200, result.data);
      return;
    }

    const body = await readEmptyJsonObject(request);
    if (body === "too_large") {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    if (body === "invalid") {
      sendJson(response, 400, { error: "empty_json_object_required" });
      return;
    }
    if (!options.isAvailable()) {
      sendJson(response, 423, { error: "vex_locked_or_starting" });
      return;
    }

    try {
      const inventory = await readInventoryBeforeDeadline(
        readInventoryShared,
        inventoryTimeoutMs,
        () => {
          // A timed-out promise may never settle (e.g. a wedged dynamic import).
          // Do not let that abandoned work poison every later snapshot request.
          inventoryReadInFlight = null;
        },
      );
      if (inventory === null) {
        logWarn("[agentscan:local] read-only inventory timed out");
        sendJson(response, 503, { error: "vex_inventory_unavailable" });
        return;
      }
      if (!options.isAvailable()) {
        sendJson(response, 423, { error: "vex_locked_or_starting" });
        return;
      }
      const tools = sanitizeAgentscanTools(inventory);
      if (tools.length === 0) {
        logWarn("[agentscan:local] no approved read-only tools available");
        sendJson(response, 503, { error: "vex_inventory_unavailable" });
        return;
      }
      sendJson(response, 200, snapshotFor(tools, intentToken ?? undefined));
    } catch {
      logWarn("[agentscan:local] read-only inventory unavailable");
      sendJson(response, 503, { error: "vex_inventory_unavailable" });
    }
  };

  const start = (): Promise<AgentscanLocalBridgeStart> => {
    const livePort = currentPort();
    if (livePort !== null) return Promise.resolve({ started: true, port: livePort });
    if (starting !== null) {
      return starting;
    }
    const epoch = lifecycle;
    const instance = createServer((request, response) => {
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy());
      void handleRequest(request, response).catch(() => {
        sendJson(response, 500, { error: "local_bridge_failed" });
      });
    });
    instance.headersTimeout = REQUEST_TIMEOUT_MS;
    instance.requestTimeout = REQUEST_TIMEOUT_MS;
    instance.keepAliveTimeout = 2_000;
    instance.maxConnections = MAX_CONNECTIONS;
    instance.maxRequestsPerSocket = 100;
    instance.on("error", () => {
      if (instance.listening) logWarn("[agentscan:local] listener failed after startup");
    });
    instance.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    const run = new Promise<AgentscanLocalBridgeStart>((resolve) => {
      const closeBefore = (result: AgentscanLocalBridgeStart): void => {
        // Do not resolve the start promise until the listener has really
        // closed. A stop/start in the same tick otherwise races the old
        // listener's close and the replacement can lose its bind.
        if (!instance.listening) {
          resolve(result);
          return;
        }
        instance.close(() => resolve(result));
      };
      const fail = (): void => {
        if (server === instance) server = null;
        logWarn(`[agentscan:local] could not bind ${AGENTSCAN_LOCAL_BRIDGE_HOST}:${String(configuredPort)}`);
        closeBefore({ started: false, port: null, reason: "bind_failed" });
      };
      instance.once("error", fail);
      instance.listen(
        { host: AGENTSCAN_LOCAL_BRIDGE_HOST, port: configuredPort, exclusive: true },
        () => {
          instance.off("error", fail);
          if (epoch !== lifecycle) {
            closeBefore({ started: false, port: null, reason: "stopped" });
            return;
          }
          server = instance;
          intentToken = `vex_session_${randomBytes(32).toString("base64url")}`;
          const bound = currentPort();
          logInfo(`[agentscan:local] read-only bridge listening on ${AGENTSCAN_LOCAL_BRIDGE_HOST}:${String(bound)}`);
          resolve({ started: true, port: bound });
        },
      );
    }).finally(() => {
      if (starting === run) starting = null;
    });
    starting = run;
    return run;
  };

  const stop = async (): Promise<void> => {
    lifecycle += 1;
    const active = server;
    server = null;
    intentToken = null;
    options.importIntents?.clear();
    options.publicationIntents?.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (active === null) {
      await starting?.catch(() => undefined);
      return;
    }
    await new Promise<void>((resolve) => active.close(() => resolve()));
  };

  const rotateCapabilityToken = (): void => {
    intentToken = server === null ? null : `vex_session_${randomBytes(32).toString("base64url")}`;
  };

  return { start, stop, rotateCapabilityToken, port: currentPort };
}
