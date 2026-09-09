import { describe, expect, it } from "vitest";
import {
  canonicalLocalAgentIdentity,
  canonicalLocalAgentPublicProfile,
  localProfileDigest,
  localProfileSlug,
  localProfileToManifest,
  parseLocalAgentIdentity,
  parseLocalAgentPublicProfile,
} from "../local-profile.js";
import { stableStringify } from "../stable-json.js";
import type { LocalAgentPublicProfile } from "@shared/schemas/agentscan-publication.js";

const profile: LocalAgentPublicProfile = {
  schema: "agentscan.vex.agent-public/1",
  semver: "1.2.3",
  manifest: {
    schemaVersion: "agentscan.strategy-manifest/1",
    name: "Wallet signal strategy",
    summary: "Read-only public signal declaration.",
    capabilities: ["read_only_market_data"],
    inputs: [{ name: "query", description: "A public market query", required: true }],
    outputs: [{ name: "signal", description: "A bounded signal" }],
    executionEnabled: false,
    strategy: { mode: "declarative", source: "user-authored-profile" },
  },
};

describe("VEX-owned AgentScan public profile", () => {
  it("round-trips only canonical bytes", () => {
    const bytes = canonicalLocalAgentPublicProfile(profile);
    expect(parseLocalAgentPublicProfile(bytes)).toEqual({ ok: true, profile });
    expect(parseLocalAgentPublicProfile(bytes.replace("\n", ""))).toEqual({ ok: false, reason: "non_canonical" });
    expect(parseLocalAgentPublicProfile(`${bytes.slice(0, -1)} `)).toEqual({ ok: false, reason: "non_canonical" });
  });

  it("rejects source-like fields and executable profiles", () => {
    expect(parseLocalAgentPublicProfile(JSON.stringify({ ...profile, sourcePath: "/tmp/secret" }))).toEqual({ ok: false, reason: "invalid_schema" });
    expect(parseLocalAgentPublicProfile(JSON.stringify({ ...profile, manifest: { ...profile.manifest, executionEnabled: true } }))).toEqual({ ok: false, reason: "invalid_schema" });
    expect(parseLocalAgentPublicProfile("not json")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseLocalAgentPublicProfile(`${stableStringify({ ...profile, manifest: { ...profile.manifest, sourceAttestation: { kind: "vex-studio-public-profile", revisionDigest: "sha256:" + "a".repeat(64), disclosure: "publisher_attested" } } })}\n`)).toEqual({ ok: false, reason: "invalid_schema" });
  });

  it("rejects obvious credential values in otherwise public fields", () => {
    for (const value of [
      "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----",
      "sk_live_12345678901234567890",
      "ghp_12345678901234567890",
      "AKIA1234567890ABCDEF",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value-123",
    ]) {
      const unsafe = { ...profile, manifest: { ...profile.manifest, summary: value } };
      expect(parseLocalAgentPublicProfile(`${stableStringify(unsafe)}\n`)).toMatchObject({ ok: false });
    }
  });

  it("derives a stable metadata-only manifest and profile digest", () => {
    const first = localProfileToManifest(profile);
    const second = localProfileToManifest(JSON.parse(canonicalLocalAgentPublicProfile(profile)) as LocalAgentPublicProfile);
    expect(first).toEqual(second);
    expect(first.manifest.executionEnabled).toBe(false);
    expect(first.manifest.name).toBe(profile.manifest.name);
    expect(first.manifest.sourceAttestation).toEqual({ kind: "vex-studio-public-profile", revisionDigest: first.profileDigest, disclosure: "publisher_attested" });
    expect(first.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.artifactDigest).toBe(first.manifestDigest);
    expect(first.profileDigest).toBe(localProfileDigest(profile));
    expect(JSON.stringify(first)).not.toContain("sourcePath");
    expect(JSON.stringify(first)).not.toContain("wallet");
  });

  it("parses identity only when the complete shape is canonical", () => {
    const identity = {
      schema: "agentscan.vex.agent-identity/1" as const,
      agentUid: "00000000-0000-4000-8000-000000000001",
      latestVersionUid: "00000000-0000-4000-8000-000000000002",
      semver: "1.2.3",
      publisherKeyId: "a".repeat(64),
      listingUid: "00000000-0000-4000-8000-000000000003",
      profileRevisionDigest: "sha256:" + "b".repeat(64),
      manifestDigest: "sha256:" + "c".repeat(64),
    };
    expect(parseLocalAgentIdentity(canonicalLocalAgentIdentity(identity))).toEqual({ ok: true, identity });
    expect(parseLocalAgentIdentity(canonicalLocalAgentIdentity(identity).replace("publisherKeyId", "unexpected"))).toEqual({ ok: false, reason: "invalid_schema" });
    expect(parseLocalAgentIdentity(`${stableStringify({ ...identity, listingUid: "not-a-uuid" })}\n`)).toEqual({ ok: false, reason: "invalid_schema" });
  });

  it("makes a safe deterministic slug from the declared name", () => {
    expect(localProfileSlug("Wallet Signal / v2")).toBe("wallet-signal-v2");
    expect(localProfileSlug("!!!")).toBe("vex-agent");
  });
});
