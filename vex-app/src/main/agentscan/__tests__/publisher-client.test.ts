import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPublisherClient, installPackageMatchesManifest, PublisherApiError } from "../publisher-client.js";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
describe("AgentScan publisher client", () => {
  it("requires the register response key id to hash the raw 32-byte key", async () => {
    const pair = generateKeyPairSync("ed25519");
    const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const publicKey = raw.toString("base64url");
    const keyId = createHash("sha256").update(raw).digest("hex");
    const client = createPublisherClient("https://agentscan.example", "ingest", (async (url: string): Promise<Response> => {
      return url.endsWith("/challenge")
        ? json({ challengeId: "challenge", signingPayload: "payload", expiresAt: "future" })
        : json({ publisherUid: "00000000-0000-4000-8000-000000000001", publicKey, publisherKeyId: keyId });
    }) as typeof fetch);
    await expect(client.register(publicKey, () => "signature")).resolves.toMatchObject({ publisherKeyId: keyId });
  });

  it("rejects a register response with a mismatched raw-key hash", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
    const client = createPublisherClient("https://agentscan.example", "ingest", (async (url: string): Promise<Response> => {
      return url.endsWith("/challenge")
        ? json({ challengeId: "challenge", signingPayload: "payload", expiresAt: "future" })
        : json({ publisherUid: "00000000-0000-4000-8000-000000000001", publicKey, publisherKeyId: "wrong" });
    }) as typeof fetch);
    await expect(client.register(publicKey, () => "signature")).rejects.toMatchObject({ code: "invalid_response" } satisfies Partial<PublisherApiError>);
  });

  it("validates cloud completion receipts before surfacing them", async () => {
    const fetcher = async (url: string): Promise<Response> => url.endsWith("/complete") ? json({ intentId: "intent", status: "completed", listing: { agent: {}, version: {}, creator: {} } }) : json({});
    const client = createPublisherClient("https://agentscan.example", "ingest", fetcher as typeof fetch);
    await expect(client.completePublication("intent", "sig")).resolves.toMatchObject({ status: "completed", listing: { agent: {} } });
  });
  it("rejects an incomplete cloud completion response", async () => {
    const client = createPublisherClient("https://agentscan.example", "ingest", async () => json({ status: "completed" }));
    await expect(client.completeInstall("intent", "sig")).rejects.toMatchObject({ code: "invalid_response" } satisfies Partial<PublisherApiError>);
  });
  it("uses the existing install-intent API routes", async () => {
    const urls: string[] = [];
    const installPackage = {
      packageSchemaVersion: "agentscan.install-package/1",
      version: { agentUid: "00000000-0000-4000-8000-000000000001", versionUid: "00000000-0000-4000-8000-000000000002", semver: "1.0.0" },
      creator: { publisherUid: "00000000-0000-4000-8000-000000000003", publisherKeyId: "a".repeat(64) },
      manifest: { schema: "agentscan.agent-version/1", agentVersionId: "av_1", productId: "product_1", name: "Example Agent", version: "1.0.0", creator: "Example", summary: "Metadata-only agent", category: "research", chain: "multi-chain", signingMode: "none", artifactAvailability: "catalog_reference_only", executionEnabled: false, agentUid: "00000000-0000-4000-8000-000000000001", versionUid: "00000000-0000-4000-8000-000000000002", manifestDigest: "sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "b".repeat(64), artifactValidationScope: "vex_attested_digest_only", provenance: { catalogSource: "server", publisherUid: "00000000-0000-4000-8000-000000000003", publisherKeyId: "a".repeat(64) } },
      manifestDigest: "sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "b".repeat(64), artifactValidationScope: "vex_attested_digest_only", executionEnabled: false,
    };
    const client = createPublisherClient("https://agentscan.example", "ingest", (async (url: string): Promise<Response> => {
      urls.push(url);
      return url.endsWith("/start") ? json({ intentId: "intent", signingPayload: "payload", expiresAt: new Date(Date.now() + 60_000).toISOString(), installPackage }) : json({ intentId: "intent", status: "completed", agentBindingUid: "binding", instanceUid: "instance", executionEnabled: false });
    }) as typeof fetch);
    await client.startInstall("key", "version", "idempotency");
    await client.completeInstall("intent", "sig");
    expect(urls).toEqual(["https://agentscan.example/api/v1/install-intents/start", "https://agentscan.example/api/v1/install-intents/complete"]);
  });
  it("registers the installer key before starting a fresh install", async () => {
    const pair = generateKeyPairSync("ed25519");
    const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const publicKey = raw.toString("base64url");
    const keyId = createHash("sha256").update(raw).digest("hex");
    const urls: string[] = [];
    const manifest = { schema: "agentscan.agent-version/1", agentVersionId: "av_1", productId: "product_1", name: "Example Agent", version: "1.0.0", creator: "Author", summary: "Metadata-only agent", category: "research", chain: "multi-chain", signingMode: "none" as const, artifactAvailability: "catalog_reference_only" as const, executionEnabled: false as const, agentUid: "00000000-0000-4000-8000-000000000001", versionUid: "00000000-0000-4000-8000-000000000002", manifestDigest: "sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "b".repeat(64), artifactValidationScope: "vex_attested_digest_only" as const, provenance: { catalogSource: "server" as const, publisherUid: "00000000-0000-4000-8000-000000000003", publisherKeyId: "a".repeat(64) } };
    const installPackage = { packageSchemaVersion: "agentscan.install-package/1" as const, version: { agentUid: manifest.agentUid, versionUid: manifest.versionUid, semver: manifest.version }, creator: { publisherUid: manifest.provenance.publisherUid, publisherKeyId: manifest.provenance.publisherKeyId }, manifest, manifestDigest: manifest.manifestDigest, artifactDigest: manifest.artifactDigest, artifactValidationScope: "vex_attested_digest_only" as const, executionEnabled: false as const };
    const client = createPublisherClient("https://agentscan.example", "ingest", (async (url: string): Promise<Response> => {
      urls.push(url);
      if (url.endsWith("/challenge")) return json({ challengeId: "challenge", signingPayload: "payload", expiresAt: "future" });
      if (url.endsWith("/register")) return json({ publisherUid: manifest.provenance.publisherUid, publicKey, publisherKeyId: keyId });
      return json({ intentId: "intent", signingPayload: "payload", expiresAt: "future", installPackage });
    }) as typeof fetch);
    await client.register(publicKey, () => "signature");
    await client.startInstall(publicKey, manifest.versionUid, "idempotency");
    expect(urls.slice(-3)).toEqual(["https://agentscan.example/api/v1/creator/publisher-keys/challenge", "https://agentscan.example/api/v1/creator/publisher-keys/register", "https://agentscan.example/api/v1/install-intents/start"]);
  });
  it("rejects an install start response without the strict package", async () => {
    const client = createPublisherClient("https://agentscan.example", "ingest", async () => json({ intentId: "intent", signingPayload: "payload", expiresAt: "future" }));
    await expect(client.startInstall("key", "version", "idempotency")).rejects.toMatchObject({ code: "invalid_response" } satisfies Partial<PublisherApiError>);
  });
  it("accepts a package authored by another publisher when local provenance matches", async () => {
    const authorKey = "a".repeat(64);
    const installerKey = "b".repeat(64);
    const sourceAttestation = { kind: "vex-studio-public-profile", revisionDigest: "sha256:" + "c".repeat(64), disclosure: "publisher_attested" } as const;
    const manifest = { schema: "agentscan.agent-version/1", agentVersionId: "av_1", productId: "product_1", name: "Example Agent", version: "1.0.0", creator: "Author", summary: "Metadata-only agent", category: "research", chain: "multi-chain", signingMode: "none", artifactAvailability: "catalog_reference_only", executionEnabled: false, agentUid: "00000000-0000-4000-8000-000000000001", versionUid: "00000000-0000-4000-8000-000000000002", manifestDigest: "sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "b".repeat(64), artifactValidationScope: "vex_attested_digest_only", provenance: { catalogSource: "server", publisherUid: "00000000-0000-4000-8000-000000000003", publisherKeyId: authorKey }, sourceAttestation } as const;
    const installPackage = { packageSchemaVersion: "agentscan.install-package/1", version: { agentUid: manifest.agentUid, versionUid: manifest.versionUid, semver: manifest.version }, creator: { publisherUid: manifest.provenance.publisherUid, publisherKeyId: authorKey }, manifest, manifestDigest: manifest.manifestDigest, artifactDigest: manifest.artifactDigest, artifactValidationScope: "vex_attested_digest_only", executionEnabled: false } as const;
    expect(authorKey).not.toBe(installerKey);
    expect(installPackageMatchesManifest(installPackage, manifest)).toBe(true);
    expect(installPackageMatchesManifest({ ...installPackage, manifest: { ...manifest, sourceAttestation: { ...sourceAttestation, revisionDigest: "sha256:" + "d".repeat(64) } } }, manifest)).toBe(false);
    const { sourceAttestation: _omitted, ...manifestWithoutAttestation } = manifest;
    expect(installPackageMatchesManifest({ ...installPackage, manifest: manifestWithoutAttestation }, manifest)).toBe(false);
    expect(installPackageMatchesManifest({ ...installPackage, creator: { ...installPackage.creator, publisherKeyId: installerKey } }, manifest)).toBe(false);
  });
  it("reports the exact local-runtime receipt flow without wallet data", async () => {
    const agentUid = "00000000-0000-4000-8000-000000000001";
    const versionUid = "00000000-0000-4000-8000-000000000002";
    const bindingUid = "00000000-0000-4000-8000-000000000003";
    const deploymentUid = "00000000-0000-4000-8000-000000000004";
    const runId = "00000000-0000-4000-8000-000000000005";
    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const artifactDigest = `sha256:${"b".repeat(64)}`;
    const runtimeBundleDigest = `sha256:${"c".repeat(64)}`;
    const inputSnapshotDigest = `sha256:${"d".repeat(64)}`;
    const sent: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    const receipt = {
      alg: "Ed25519",
      receiptDigest: `sha256:${"e".repeat(64)}`,
      publicKey: "publisher-key",
      signature: "publisher-signature",
      signingPayload: { schemaVersion: "agentscan.local-runtime-receipt/1" },
    };
    const client = createPublisherClient("https://agentscan.example", "ingest", (async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push({ url, body });
      if (url.endsWith("/deployments/ack")) {
        return json({ agentUid, versionUid, deploymentUid, manifestDigest, artifactDigest, runtimeBundleDigest, status: "active", deploymentReceipt: receipt });
      }
      if (url.endsWith("/runs/start")) {
        return json({ agentUid, versionUid, deploymentUid, runId, inputSnapshotDigest, manifestDigest, artifactDigest, runtimeBundleDigest, status: "running" });
      }
      return json({ runId, status: "completed", resultReceipt: receipt });
    }) as typeof fetch);
    const deployment = await client.acknowledgeLocalDeployment({ agentUid, versionUid, bindingUid, localDeploymentId: "vex:deployment", manifestDigest, artifactDigest, runtimeBundleDigest, receipt });
    await client.startLocalRun({ agentUid, versionUid, bindingUid, deploymentUid, runId, inputSnapshotDigest, manifestDigest, artifactDigest, runtimeBundleDigest, receipt });
    await client.completeLocalRun({ runId, artifact: { artifactDigest: inputSnapshotDigest, byteLength: 1, contentType: "application/json", producedAt: "2026-09-10T00:00:00.000Z" }, receipt });
    expect(sent.map((request) => request.url)).toEqual([
      "https://agentscan.example/api/v1/local-runtime/deployments/ack",
      "https://agentscan.example/api/v1/local-runtime/runs/start",
      "https://agentscan.example/api/v1/local-runtime/runs/result",
    ]);
    expect(sent[0]?.body).toMatchObject({ agentUid, versionUid, bindingUid, manifestDigest, artifactDigest, runtimeBundleDigest });
    expect(sent.map((request) => request.body.schemaVersion)).toEqual([
      "agentscan.local-deployment-ack/1",
      "agentscan.local-run-start/1",
      "agentscan.local-run-result/1",
    ]);
    expect(deployment.receipt).not.toHaveProperty("receiptDigest");
    expect(JSON.stringify(sent)).not.toMatch(/wallet|token|address/i);
  });
  it("uses the Vercel acknowledgement route only for a validated deployment record", async () => {
    const url: string[] = [];
    const client = createPublisherClient("https://agentscan.example", "ingest", (async (nextUrl: string): Promise<Response> => {
      url.push(nextUrl);
      return json({
        deploymentUid: "00000000-0000-4000-8000-000000000001",
        endpoint: "https://portfolio-runtime.vercel.app/api/run",
        healthEndpoint: "https://portfolio-runtime.vercel.app/api/health",
        runtimeBundleDigest: `sha256:${"a".repeat(64)}`,
        status: "ready",
      });
    }) as typeof fetch);
    await expect(client.acknowledgeVercelDeployment({ schemaVersion: "agentscan.vercel-deployment-ack/1" })).resolves.toMatchObject({ status: "ready" });
    expect(url).toEqual(["https://agentscan.example/api/v1/vercel-runtime/deployments/ack"]);
  });
});
