import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENTSCAN_CONNECTOR_HEADER,
  AGENTSCAN_PRODUCTION_ORIGINS,
  createAgentscanLocalBridge,
  isAllowedLoopbackHost,
  isAllowedPrivateNetworkPreflight,
  parseAgentscanImportRequest,
  sanitizeAgentscanTools,
  type AgentscanLocalBridge,
  type AgentscanInventoryTool,
} from "../local-readonly-bridge.js";
import { PublicationIntentRegistry } from "../publication-intents.js";

const ORIGIN = "https://agentscan-v7-1-clickable-demo.vercel.app";
const SECRET_MARKER = "private-wallet-secret";

const INVENTORY: readonly AgentscanInventoryTool[] = [
  {
    publicName: "pools__tokens_search",
    title: SECRET_MARKER,
    description: SECRET_MARKER,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    publicName: "virtuals__agents_discover",
    title: "Discover Virtuals agents",
    description: "Read public agent data",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    publicName: "pools__launch_assets_list",
    title: SECRET_MARKER,
    description: SECRET_MARKER,
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    publicName: "WalletSend",
    title: SECRET_MARKER,
    description: SECRET_MARKER,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

const bridges: AgentscanLocalBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

async function running(available = true, publicationIntents?: PublicationIntentRegistry): Promise<{ bridge: AgentscanLocalBridge; base: string }> {
  const bridge = createAgentscanLocalBridge({
    port: 0,
    allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
    isAvailable: () => available,
    readInventory: async () => INVENTORY,
    publicationIntents,
  });
  bridges.push(bridge);
  const started = await bridge.start();
  expect(started.started).toBe(true);
  return { bridge, base: `http://127.0.0.1:${String(started.port)}` };
}

function snapshotHeaders(origin = ORIGIN): Record<string, string> {
  return {
    Origin: origin,
    "Content-Type": "application/json",
    "X-AgentScan-Connector": AGENTSCAN_CONNECTOR_HEADER,
  };
}

describe("AgentScan local read-only bridge", () => {
  it("keeps the listener bound while locked and reveals no capability data", async () => {
    let available = false;
    let inventoryReads = 0;
    const bridge = createAgentscanLocalBridge({
      port: 0,
      allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
      isAvailable: () => available,
      readInventory: async () => { inventoryReads += 1; return INVENTORY; },
    });
    bridges.push(bridge);
    const started = await bridge.start();
    expect(started.started).toBe(true);
    const base = `http://127.0.0.1:${String(started.port)}`;
    const response = await fetch(`${base}/v1/snapshot`, { method: "POST", headers: snapshotHeaders(), body: "{}" });
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ error: "vex_locked_or_starting" });
    expect(inventoryReads).toBe(0);
    available = true;
    bridge.rotateCapabilityToken();
    const unlocked = await fetch(`${base}/v1/snapshot`, { method: "POST", headers: snapshotHeaders(), body: "{}" });
    expect(unlocked.status).toBe(200);
  });

  it("creates an opaque local publication launch and never accepts a manifest", async () => {
    const publications = new PublicationIntentRegistry();
    const { base } = await running(true, publications);
    const snapshotResponse = await fetch(`${base}/v1/snapshot`, { method: "POST", headers: snapshotHeaders(), body: "{}" });
    const snapshot = await snapshotResponse.json() as { bridge?: { intentToken?: string } };
    const session = snapshot.bridge?.intentToken;
    expect(session).toEqual(expect.any(String));
    if (typeof session !== "string") throw new Error("snapshot did not return a session token");
    const headers = { ...snapshotHeaders(), "X-AgentScan-Session": session };
    const response = await fetch(`${base}/v1/local-agent-publications`, {
      method: "POST", headers,
      body: JSON.stringify({ schema: "agentscan.local-publication-launch/1", idempotencyKey: "33333333-3333-4333-8333-333333333333" }),
    });
    const value = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(value).toMatchObject({ schema: "agentscan.vex.publication-intent/1", state: "awaiting_review" });
    expect(value).not.toHaveProperty("request");
    expect(value).not.toHaveProperty("manifest");
    const rejected = await fetch(`${base}/v1/local-agent-publications`, { method: "POST", headers, body: JSON.stringify({ schema: "agentscan.local-publication-launch/1", idempotencyKey: "44444444-4444-4444-8444-444444444444", manifest: {} }) });
    expect(rejected.status).toBe(400);
  });

  it("allows only sanitized read-only market metadata from the exact production origin", async () => {
    const { base } = await running();
    const response = await fetch(`${base}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: "{}",
    });
    const raw = await response.text();
    const snapshot = JSON.parse(raw) as Record<string, unknown>;
    const syncContract = snapshot.syncContract as { link: { state: string } };
    const tools = snapshot.tools as Array<{ name: string }>;

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(snapshot.schema).toBe("agentscan.vex.snapshot/1");
    expect(snapshot.mode).toBe("read-only");
    expect(snapshot.localOnly).toBe(true);
    expect(snapshot.projectRef).toBeNull();
    expect(syncContract.link.state).toBe("studio_ready");
    expect(tools.map((tool) => tool.name)).toEqual([
      "pools__tokens_search",
      "virtuals__agents_discover",
    ]);
    expect(snapshot.receipt).toMatchObject({
      projectIdsExposed: false,
      databaseAccessed: false,
      personalMemoryAccessed: false,
      mutationToolsExecuted: 0,
      walletAccessed: false,
    });
    expect(raw).not.toContain(SECRET_MARKER);
    expect(raw).not.toContain("title");
    expect(raw).not.toContain("description");
    expect(raw).not.toContain("inputSchema");
  });

  it("answers a valid private-network preflight and rejects an untrusted origin", async () => {
    const { base } = await running();
    const preflight = await fetch(`${base}/v1/snapshot`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-agentscan-connector",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");

    const denied = await fetch(`${base}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders("https://evil.example"),
      body: "{}",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects DNS-rebinding hosts, unexpected bodies, methods, and missing connector proof", async () => {
    const { base, bridge } = await running();
    const port = bridge.port();
    expect(port).not.toBeNull();
    if (port === null) throw new Error("bridge did not expose a port");
    expect(isAllowedLoopbackHost(`127.0.0.1:${String(port)}`, port)).toBe(true);
    expect(isAllowedLoopbackHost(`localhost:${String(port)}`, port)).toBe(false);
    expect(isAllowedLoopbackHost(`attacker.example:${String(port)}`, port)).toBe(false);

    const reboundStatus = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/v1/snapshot",
        method: "POST",
        headers: { ...snapshotHeaders(), Host: `attacker.example:${String(port)}` },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      req.once("error", reject);
      req.end("{}");
    });
    expect(reboundStatus).toBe(421);

    const extraBody = await fetch(`${base}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: JSON.stringify({ projectId: "not-accepted" }),
    });
    expect(extraBody.status).toBe(400);

    const wrongMethod = await fetch(`${base}/v1/snapshot`, {
      method: "GET",
      headers: { Origin: ORIGIN },
    });
    expect(wrongMethod.status).toBe(405);

    const missingHeader = await fetch(`${base}/v1/snapshot`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingHeader.status).toBe(400);
  });

  it("fails closed when Vex is locked and never returns private failure details", async () => {
    let available = true;
    const bridge = createAgentscanLocalBridge({
      port: 0,
      allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
      isAvailable: () => available,
      readInventory: async () => {
        throw new Error(SECRET_MARKER);
      },
    });
    bridges.push(bridge);
    const started = await bridge.start();
    const base = `http://127.0.0.1:${String(started.port)}`;

    const unavailable = await fetch(`${base}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: "{}",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(SECRET_MARKER);

    available = false;
    const locked = await fetch(`${base}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: "{}",
    });
    expect(locked.status).toBe(423);
  });

  it("fails closed when no approved read-only capability is available", async () => {
    const bridge = createAgentscanLocalBridge({
      port: 0,
      allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
      isAvailable: () => true,
      readInventory: async () => [{
        publicName: "WalletSend",
        title: SECRET_MARKER,
        description: SECRET_MARKER,
        annotations: { readOnlyHint: true, destructiveHint: false },
      }],
    });
    bridges.push(bridge);
    const started = await bridge.start();
    const response = await fetch(`http://127.0.0.1:${String(started.port)}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "vex_inventory_unavailable" });
  });

  it("shares a timed-out inventory read instead of accumulating background work", async () => {
    let inventoryReads = 0;
    const bridge = createAgentscanLocalBridge({
      port: 0,
      inventoryTimeoutMs: 20,
      allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
      isAvailable: () => true,
      readInventory: () => {
        inventoryReads += 1;
        return new Promise(() => undefined);
      },
    });
    bridges.push(bridge);
    const started = await bridge.start();
    const url = `http://127.0.0.1:${String(started.port)}/v1/snapshot`;
    const responses = await Promise.all([
      fetch(url, { method: "POST", headers: snapshotHeaders(), body: "{}" }),
      fetch(url, { method: "POST", headers: snapshotHeaders(), body: "{}" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    expect(inventoryReads).toBe(1);
  });

  it("fails closed if Vex locks while the inventory is being read", async () => {
    let available = true;
    let releaseInventory!: () => void;
    let inventoryStarted!: () => void;
    const inventoryDidStart = new Promise<void>((resolve) => {
      inventoryStarted = resolve;
    });
    const inventoryRelease = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const bridge = createAgentscanLocalBridge({
      port: 0,
      allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
      isAvailable: () => available,
      readInventory: async () => {
        inventoryStarted();
        await inventoryRelease;
        return INVENTORY;
      },
    });
    bridges.push(bridge);
    const started = await bridge.start();
    const responsePromise = fetch(`http://127.0.0.1:${String(started.port)}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: "{}",
    });

    await inventoryDidStart;
    available = false;
    releaseInventory();

    const response = await responsePromise;
    expect(response.status).toBe(423);
  });

  it("bounds inventory reads and recovers an unlock that races a pending stop", async () => {
    const bridge = createAgentscanLocalBridge({
      port: 0,
      inventoryTimeoutMs: 20,
      allowedOrigins: AGENTSCAN_PRODUCTION_ORIGINS,
      isAvailable: () => true,
      readInventory: () => new Promise(() => undefined),
    });
    bridges.push(bridge);

    const firstStart = bridge.start();
    const stopping = bridge.stop();
    await Promise.all([firstStart, stopping]);
    const restartResult = await bridge.start();
    expect(restartResult.started).toBe(true);

    const response = await fetch(`http://127.0.0.1:${String(restartResult.port)}/v1/snapshot`, {
      method: "POST",
      headers: snapshotHeaders(),
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "vex_inventory_unavailable" });
  });

  it("rejects preflights that request extra headers", async () => {
    const { base } = await running();
    const response = await fetch(`${base}/v1/snapshot`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-agentscan-connector, authorization",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(response.status).toBe(403);
  });
});

describe("sanitizeAgentscanTools", () => {
  it("deduplicates allowed read-only entries", () => {
    const first = INVENTORY.at(0);
    if (first === undefined) throw new Error("inventory fixture is empty");
    expect(sanitizeAgentscanTools([...INVENTORY, first])).toHaveLength(2);
  });
});

describe("AgentScan import HTTP boundary", () => {
  const manifest = {
    schema: "agentscan.agent-version/1" as const,
    agentVersionId: "av_test",
    productId: "product_test",
    name: "Test Agent",
    version: "1.0.0",
    creator: "Test",
    summary: "Metadata only",
    category: "research",
    chain: "multi-chain",
    signingMode: "none" as const,
    artifactAvailability: "catalog_reference_only" as const,
    executionEnabled: false as const,
  };

  it("requires PNA and an exact import request body", () => {
    expect(isAllowedPrivateNetworkPreflight("true")).toBe(true);
    expect(isAllowedPrivateNetworkPreflight(undefined)).toBe(false);
    expect(isAllowedPrivateNetworkPreflight(
      undefined,
      "http://localhost:3011",
      new Set(["http://localhost:3011"]),
    )).toBe(true);
    expect(isAllowedPrivateNetworkPreflight("false", "http://localhost:3011")).toBe(false);
    expect(isAllowedPrivateNetworkPreflight(undefined, ORIGIN)).toBe(true);
    expect(isAllowedPrivateNetworkPreflight(undefined, "https://not-agentscan.example")).toBe(false);
    const valid = {
      schema: "agentscan.vex.import-request/1",
      idempotencyKey: "request-1",
      manifestDigest: "sha256:abc",
      manifest,
    };
    expect(parseAgentscanImportRequest(valid)).toMatchObject({ idempotencyKey: "request-1", manifest });
    expect(parseAgentscanImportRequest({ ...valid, schema: "wrong" })).toBeNull();
    expect(parseAgentscanImportRequest({ ...valid, extra: true })).toBeNull();
  });
});
