import { verify as verifySignature } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentscanImportIntentRegistry,
  canonicalAgentScanManifest,
  digestAgentScanManifest,
  importPreviewFileStateMatches,
  canonicalBindingFile,
  classifyExistingBindingForImport,
  parseCanonicalBindingFile,
} from "../import-intents.js";
import { stableStringify } from "../stable-json.js";
import { agentScanManifestSchema, agentScanSignedReceiptSchema } from "@shared/schemas/agentscan-import.js";

const manifest = {
  schema: "agentscan.agent-version/1" as const,
  agentVersionId: "av_1",
  productId: "product_1",
  name: "Example Agent",
  version: "1.0.0",
  creator: "Example",
  summary: "Metadata-only agent",
  category: "research",
  chain: "multi-chain",
  signingMode: "none" as const,
  artifactAvailability: "catalog_reference_only" as const,
  executionEnabled: false as const,
};

const sourceAttestation = {
  kind: "vex-studio-public-profile" as const,
  revisionDigest: `sha256:${"a".repeat(64)}`,
  disclosure: "publisher_attested" as const,
};

function create(registry: AgentscanImportIntentRegistry, idempotencyKey = "key") {
  const manifestDigest = digestAgentScanManifest(manifest);
  return registry.create({ idempotencyKey, manifestDigest, manifest, sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app" });
}

describe("AgentScan import intent registry", () => {
  it("accepts the exact source attestation and rejects malformed or extra fields", () => {
    const serverManifest = {
      ...manifest,
      agentUid: "00000000-0000-4000-8000-000000000001",
      versionUid: "00000000-0000-4000-8000-000000000002",
      manifestDigest: `sha256:${"b".repeat(64)}`,
      artifactDigest: `sha256:${"c".repeat(64)}`,
      artifactValidationScope: "vex_attested_digest_only" as const,
      provenance: { catalogSource: "server" as const, publisherUid: "00000000-0000-4000-8000-000000000003", publisherKeyId: "d".repeat(64) },
      sourceAttestation,
    };
    expect(agentScanManifestSchema.safeParse(serverManifest).success).toBe(true);
    expect(agentScanManifestSchema.safeParse({ ...serverManifest, sourceAttestation: { ...sourceAttestation, revisionDigest: "not-a-digest" } }).success).toBe(false);
    expect(agentScanManifestSchema.safeParse({ ...serverManifest, sourceAttestation: { ...sourceAttestation, extra: true } }).success).toBe(false);
  });

  it("requires complete identity and digest attestation for server provenance", () => {
    expect(agentScanManifestSchema.safeParse({ ...manifest, provenance: { catalogSource: "server", publisherUid: "00000000-0000-4000-8000-000000000003", publisherKeyId: "a".repeat(64) } }).success).toBe(false);
  });

  it("uses a deterministic prefixed manifest digest and replays idempotently", () => {
    const digest = digestAgentScanManifest(manifest);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(digestAgentScanManifest(JSON.parse(canonicalAgentScanManifest(manifest)))).toBe(digest);
    const registry = new AgentscanImportIntentRegistry();
    const first = create(registry);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = create(registry);
    expect(replay).toMatchObject({ ok: true, replay: true, data: first.data });
    expect(create(registry, "different")).toMatchObject({ ok: true, replay: false });
    expect(registry.create({ idempotencyKey: "key", manifestDigest: digest, manifest: { ...manifest, name: "Changed" }, sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app" })).toMatchObject({ ok: false, reason: "idempotency_collision" });
  });

  it("expires pending intents and enforces the pending bound", () => {
    let now = 1_000;
    const registry = new AgentscanImportIntentRegistry({ now: () => now, maxPending: 1 });
    expect(create(registry).ok).toBe(true);
    expect(create(registry, "second")).toMatchObject({ ok: false, reason: "pending_bound" });
    now += 300_001;
    expect(registry.getPending()).toBeNull();
    expect(create(registry, "second").ok).toBe(true);
  });

  it("retains terminal status for bounded polling and clears its idempotency key", () => {
    let now = 1_000;
    const registry = new AgentscanImportIntentRegistry({ now: () => now, ttlMs: 10 });
    const created = create(registry);
    if (!created.ok) throw new Error("create failed");
    expect(registry.reject(created.data.intentId)).toBe("rejected");
    expect(registry.status(created.data.intentId)).toMatchObject({ ok: true, data: { state: "rejected" } });
    now += 11;
    expect(registry.status(created.data.intentId)).toMatchObject({ ok: true, data: { state: "rejected" } });
    now += 10;
    expect(registry.status(created.data.intentId)).toMatchObject({ ok: false, reason: "not_found" });
    expect(create(registry).ok).toBe(true);
  });

  it("shares concurrent confirmation and signs only one receipt", async () => {
    const registry = new AgentscanImportIntentRegistry();
    const created = create(registry);
    if (!created.ok) throw new Error("create failed");
    const intentId = created.data.intentId;
    const preview = registry.setPreview(intentId, {
      intentId,
      projectId: "00000000-0000-4000-8000-000000000001",
      scopeVersion: 1,
      manifestDigest: digestAgentScanManifest(manifest),
      action: "create",
      relativePath: ".vex/agentscan/hash.json",
      fileHash: null,
      previousSourceOrigin: null,
    });
    if (preview === null) throw new Error("preview failed");
    let writes = 0;
    const verify = async () => {
      writes += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return registry.signReceipt({
        intentId,
        agentVersionId: manifest.agentVersionId,
        manifestDigest: digestAgentScanManifest(manifest),
        projectRef: "sha256:project",
        projectRevision: "1",
        sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app",
        authority: { walletAccess: false, signing: false, execution: false },
        mutation: { kind: "project_metadata_binding", changed: true },
      });
    };
    const [one, two] = await Promise.all([
      registry.confirm(intentId, preview.previewToken, preview.projectId, 1, verify),
      registry.confirm(intentId, preview.previewToken, preview.projectId, 1, verify),
    ]);
    expect(writes).toBe(1);
    expect(one.outcome).toBe("approved");
    expect(two.outcome).toBe("already_approved");
    if (one.outcome !== "approved" || two.outcome !== "already_approved") return;
    expect(two.receipt.payload.receiptId).toBe(one.receipt.payload.receiptId);
    expect(verifySignature(null, Buffer.from(stableStringify(one.receipt.payload)), { key: Buffer.from(one.receipt.signature.publicKey, "base64url"), format: "der", type: "spki" }, Buffer.from(one.receipt.signature.signature, "base64url"))).toBe(true);
  });

  it("keeps a safe local approval when optional cloud install enrichment fails", async () => {
    const registry = new AgentscanImportIntentRegistry();
    const created = create(registry, "cloud-failure");
    if (!created.ok) throw new Error("create failed");
    const preview = registry.setPreview(created.data.intentId, {
      intentId: created.data.intentId,
      projectId: "00000000-0000-4000-8000-000000000001",
      scopeVersion: 1,
      manifestDigest: digestAgentScanManifest(manifest),
      action: "create",
      relativePath: ".vex/agentscan/hash.json",
      fileHash: null,
      previousSourceOrigin: null,
    });
    if (preview === null) throw new Error("preview failed");
    const result = await registry.confirm(created.data.intentId, preview.previewToken, preview.projectId, 1, async () => {
      let cloudInstall: undefined;
      try { throw new Error("backend unavailable"); } catch { cloudInstall = undefined; }
      const receipt = registry.signReceipt({
        intentId: created.data.intentId,
        agentVersionId: manifest.agentVersionId,
        manifestDigest: digestAgentScanManifest(manifest),
        projectRef: "sha256:project",
        projectRevision: "1",
        sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app",
        authority: { walletAccess: false, signing: false, execution: false },
        mutation: { kind: "project_metadata_binding", changed: true },
      }, cloudInstall);
      return receipt;
    });
    expect(result.outcome).toBe("approved");
    if (result.outcome === "approved") {
      expect(result.receipt.payload.cloudInstall).toBeUndefined();
      expect(result.receipt).not.toHaveProperty("cloudInstall");
      expect(agentScanSignedReceiptSchema.safeParse(result.receipt).success).toBe(true);
    }
  });

  it("does not let reject race an in-flight confirmation", async () => {
    const registry = new AgentscanImportIntentRegistry();
    const created = create(registry);
    if (!created.ok) throw new Error("create failed");
    const preview = registry.setPreview(created.data.intentId, {
      intentId: created.data.intentId,
      projectId: "00000000-0000-4000-8000-000000000001",
      scopeVersion: 1,
      manifestDigest: digestAgentScanManifest(manifest),
      action: "create",
      relativePath: ".vex/agentscan/hash.json",
      fileHash: null,
      previousSourceOrigin: null,
    });
    if (preview === null) throw new Error("preview failed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const confirmation = registry.confirm(created.data.intentId, preview.previewToken, preview.projectId, 1, async () => {
      await gate;
      return registry.signReceipt({
        intentId: created.data.intentId,
        agentVersionId: manifest.agentVersionId,
        manifestDigest: digestAgentScanManifest(manifest),
        projectRef: "sha256:project",
        projectRevision: "1",
        sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app",
        authority: { walletAccess: false, signing: false, execution: false },
        mutation: { kind: "project_metadata_binding", changed: true },
      });
    });
    await Promise.resolve();
    expect(registry.reject(created.data.intentId)).toBe("already_terminal");
    release();
    expect((await confirmation).outcome).toBe("approved");
  });

  it("rotates the ephemeral receipt key when the registry is cleared", () => {
    const registry = new AgentscanImportIntentRegistry();
    const payload = {
      intentId: "asi_test",
      agentVersionId: manifest.agentVersionId,
      manifestDigest: digestAgentScanManifest(manifest),
      projectRef: "sha256:project",
      projectRevision: "1",
      sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app",
      authority: { walletAccess: false, signing: false, execution: false } as const,
      mutation: { kind: "project_metadata_binding" as const, changed: false },
    };
    const before = registry.signReceipt(payload).signature.publicKey;
    registry.clear();
    const after = registry.signReceipt(payload).signature.publicKey;
    expect(after).not.toBe(before);
  });

  it("treats preview file state as exact optimistic concurrency", () => {
    expect(importPreviewFileStateMatches({ fileHash: "hash-before" }, "hash-before")).toBe(true);
    expect(importPreviewFileStateMatches({ fileHash: "hash-before" }, "hash-after")).toBe(false);
    expect(importPreviewFileStateMatches({ fileHash: "hash-before" }, null)).toBe(false);
    expect(importPreviewFileStateMatches({ fileHash: null }, null)).toBe(true);
  });

  it("accepts only canonical bindings when checking an origin migration", () => {
    const text = canonicalBindingFile({
      manifestDigest: digestAgentScanManifest(manifest),
      manifest,
      sourceOrigin: "http://localhost:3000",
    });
    expect(parseCanonicalBindingFile(text)).toMatchObject({
      manifestDigest: digestAgentScanManifest(manifest),
      sourceOrigin: "http://localhost:3000",
    });
    expect(parseCanonicalBindingFile(`${text} `)).toBeNull();
    expect(parseCanonicalBindingFile(JSON.stringify({
      schema: "agentscan.vex.agent-binding/1",
      manifestDigest: digestAgentScanManifest(manifest),
      manifest,
      sourceOrigin: "http://localhost:3000",
    }))).toBeNull();
    expect(classifyExistingBindingForImport({
      text,
      manifestDigest: digestAgentScanManifest(manifest),
      manifest,
      sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app",
    })).toEqual({ action: "update_origin", previousSourceOrigin: "http://localhost:3000" });
    expect(classifyExistingBindingForImport({
      text: canonicalBindingFile({
        manifestDigest: digestAgentScanManifest({ ...manifest, name: "Other" }),
        manifest: { ...manifest, name: "Other" },
        sourceOrigin: "http://localhost:3000",
      }),
      manifestDigest: digestAgentScanManifest(manifest),
      manifest,
      sourceOrigin: "https://agentscan-v7-1-clickable-demo.vercel.app",
    })).toBeNull();
  });
});
