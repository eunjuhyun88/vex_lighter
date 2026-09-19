import { describe, expect, it } from "vitest";
import { PublicationIntentRegistry, publicationManifestDigest } from "../publication-intents.js";
import { publicationRequestSchema, type PublicationRequest } from "@shared/schemas/agentscan-publication.js";

const manifest = {
  schemaVersion: "agentscan.strategy-manifest/1" as const, name: "Read-only strategy", summary: "No execution", capabilities: ["observe"],
  inputs: [], outputs: [{ name: "signal", description: "A signal" }], executionEnabled: false as const, strategy: { mode: "catalog" },
};
function request(): PublicationRequest {
  const parsed = publicationRequestSchema.parse({
    schema: "agentscan.vex.publication-request/1",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    agent: { slug: "read-only-strategy", displayName: "Read-only strategy", summary: "No execution" },
    version: { semver: "1.0.0", manifest, manifestDigest: "sha256:" + "0".repeat(64), artifactDigest: "sha256:" + "0".repeat(64) },
  });
  const digest = publicationManifestDigest(parsed);
  return { ...parsed, version: { ...parsed.version, manifestDigest: digest, artifactDigest: digest } };
}

describe("publication intent registry", () => {
  it("accepts only a canonical bounded manifest and replays exact idempotency", () => {
    const registry = new PublicationIntentRegistry({ now: () => 1_000 });
    const input = request();
    const first = registry.create("https://agentscan.example", input);
    expect(first.ok && first.replay).toBe(false);
    expect(registry.create("https://agentscan.example", input)).toMatchObject({ ok: true, replay: true });
    expect(registry.getPending()?.request?.version.manifest.executionEnabled).toBe(false);
  });
  it("refuses an idempotency key reused for changed public JSON", () => {
    const registry = new PublicationIntentRegistry();
    const input = request();
    registry.create("https://agentscan.example", input);
    const changed = { ...input, version: { ...input.version, semver: "1.0.1" } };
    expect(registry.create("https://agentscan.example", changed)).toEqual({ ok: false, reason: "idempotency_collision" });
  });

  it("replays a terminal intent as terminal instead of awaiting review", () => {
    const registry = new PublicationIntentRegistry();
    const input = request();
    const created = registry.create("https://agentscan.example", input);
    if (!created.ok) throw new Error("create failed");
    expect(registry.reject(created.data.intentId)).toBe("rejected");
    expect(registry.create("https://agentscan.example", input)).toMatchObject({
      ok: true,
      replay: true,
      data: {
        schema: "agentscan.vex.publication-status/1",
        intentId: created.data.intentId,
        state: "rejected",
      },
    });
  });

  it("reopens an exactly matching failed intent, while changed retries still collide", async () => {
    const registry = new PublicationIntentRegistry();
    const input = request();
    const created = registry.create("https://agentscan.example", input);
    if (!created.ok) throw new Error("create failed");
    const review = registry.get(created.data.intentId);
    if (!review) throw new Error("missing intent");
    const preview = registry.setPreview(created.data.intentId, { projectId: "00000000-0000-4000-8000-000000000001", scopeVersion: 1, relativePath: ".vex/agentscan/publications/hash.json", fileHash: null, action: "create" });
    if (!preview) throw new Error("missing preview");
    await registry.confirm(created.data.intentId, preview.previewToken, preview.projectId, 1, async () => ({ outcome: "failed", failure: { code: "unavailable" } }));
    expect(registry.status(created.data.intentId)?.state).toBe("failed");
    expect(registry.status(created.data.intentId)?.error).toBe("unavailable");
    await expect(registry.confirm(created.data.intentId, preview.previewToken, preview.projectId, 1, async () => ({ outcome: "preview_stale" }))).resolves.toEqual({ outcome: "failed", failure: { code: "unavailable" } });
    expect(registry.create("https://agentscan.example", input)).toMatchObject({ ok: true, replay: true, data: { intentId: created.data.intentId } });
    expect(registry.status(created.data.intentId)?.state).toBe("awaiting_review");
    expect(registry.status(created.data.intentId)?.error).toBeUndefined();
    expect(registry.create("https://agentscan.example", { ...input, version: { ...input.version, semver: "2.0.0" } })).toEqual({ ok: false, reason: "idempotency_collision" });
  });

  it("keeps a local launch opaque after main binds its request", () => {
    const registry = new PublicationIntentRegistry();
    const key = "22222222-2222-4222-8222-222222222222";
    const created = registry.createLocal("https://agentscan.example", key);
    if (!created.ok) throw new Error("create failed");
    const bound = registry.setLocalRequest(created.data.intentId, { ...request(), idempotencyKey: key });
    expect(bound?.mode).toBe("local_project");
    expect(registry.getPending()).toMatchObject({ mode: "local_project", request: { schema: "agentscan.vex.publication-request/1" } });
    expect(registry.createLocal("https://agentscan.example", key)).toMatchObject({ ok: true, replay: true, data: { intentId: created.data.intentId } });
  });

  it("requires an existing agent when an update parent is supplied", () => {
    const input = request();
    expect(registryRequestWithParent(input, { agent: { slug: "new-agent", displayName: "New agent", summary: "new" } })).toBe(false);
    expect(registryRequestWithParent(input, { agent: { agentUid: "00000000-0000-4000-8000-000000000001" } })).toBe(true);
  });

  it("keeps a local form review alive beyond the short browser request TTL", () => {
    let now = 1_000;
    const registry = new PublicationIntentRegistry({ now: () => now });
    const created = registry.createLocal("https://agentscan.example", "44444444-4444-4444-8444-444444444444");
    if (!created.ok) throw new Error("create failed");
    now += 6 * 60 * 1_000;
    expect(registry.status(created.data.intentId)?.state).toBe("awaiting_review");
    now += 25 * 60 * 1_000;
    expect(registry.status(created.data.intentId)?.state).toBe("expired");
  });
});

function registryRequestWithParent(input: PublicationRequest, patch: Pick<PublicationRequest, "agent">): boolean {
  const candidate = { ...input, ...patch, parentVersionUid: "00000000-0000-4000-8000-000000000002" };
  return publicationRequestSchema.safeParse(candidate).success;
}
