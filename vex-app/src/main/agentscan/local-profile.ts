/**
 * VEX-owned public profile for the local-first AgentScan publication path.
 *
 * This module is deliberately independent from the browser bridge.  The only
 * bytes it accepts are the one profile file VEX owns inside a confined Studio
 * project.  It never walks a project, reads a source file, inspects wallets or
 * derives a strategy from the selected coding-agent roster.
 */

import { createHash } from "node:crypto";
import {
  localAgentIdentitySchema,
  localAgentPublicProfileSchema,
  type LocalAgentIdentity,
  type LocalAgentPublicProfile,
} from "@shared/schemas/agentscan-publication.js";
import { stableStringify } from "./stable-json.js";

/** Static path; callers must still resolve it through confined-fs. */
export const LOCAL_AGENT_PUBLIC_PROFILE_PATH = ".vex/agentscan/agent.public.json";
/** Identity is metadata only and does not authorize execution. */
export const LOCAL_AGENT_IDENTITY_PATH = ".vex/agentscan/identity.json";

export type LocalProfileParseResult =
  | { readonly ok: true; readonly profile: LocalAgentPublicProfile }
  | { readonly ok: false; readonly reason: "invalid_json" | "invalid_schema" | "non_canonical" };

export type LocalIdentityParseResult =
  | { readonly ok: true; readonly identity: LocalAgentIdentity }
  | { readonly ok: false; readonly reason: "invalid_json" | "invalid_schema" | "non_canonical" };

function parseCanonical<T>(
  text: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): { ok: true; value: T } | { ok: false; reason: "invalid_json" | "invalid_schema" | "non_canonical" } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "invalid_schema" };
  if (`${stableStringify(parsed.data)}\n` !== text) return { ok: false, reason: "non_canonical" };
  return { ok: true, value: parsed.data };
}

/** Parse exactly the canonical VEX profile bytes. */
export function parseLocalAgentPublicProfile(text: string): LocalProfileParseResult {
  const parsed = parseCanonical(text, localAgentPublicProfileSchema);
  return parsed.ok ? { ok: true, profile: parsed.value } : parsed;
}

/** Parse exactly the canonical VEX identity bytes. */
export function parseLocalAgentIdentity(text: string): LocalIdentityParseResult {
  const parsed = parseCanonical(text, localAgentIdentitySchema);
  return parsed.ok ? { ok: true, identity: parsed.value } : parsed;
}

/** Canonical bytes VEX writes; the trailing newline is part of the contract. */
export function canonicalLocalAgentPublicProfile(profile: LocalAgentPublicProfile): string {
  return `${stableStringify(localAgentPublicProfileSchema.parse(profile))}\n`;
}

export function canonicalLocalAgentIdentity(identity: LocalAgentIdentity): string {
  return `${stableStringify(localAgentIdentitySchema.parse(identity))}\n`;
}

/** Digest only the VEX-owned profile bytes, never the surrounding project. */
export function localProfileDigest(profile: LocalAgentPublicProfile): string {
  return `sha256:${createHash("sha256").update(canonicalLocalAgentPublicProfile(profile), "utf8").digest("hex")}`;
}

/** Build the publication payload after the user has selected the project. */
export function localProfileToManifest(profile: LocalAgentPublicProfile) {
  // The profile parser is the file boundary; this function only projects its
  // already-validated public declaration. It never adds an execution route.
  const profileDigest = localProfileDigest(profile);
  const manifest = {
    ...profile.manifest,
    sourceAttestation: { kind: "vex-studio-public-profile" as const, revisionDigest: profileDigest, disclosure: "publisher_attested" as const },
  };
  const manifestDigest = `sha256:${createHash("sha256").update(stableStringify(manifest), "utf8").digest("hex")}`;
  return { manifest, manifestDigest, artifactDigest: manifestDigest, profileDigest };
}

/** Slug is derived only from the declared public name, never from a path. */
export function localProfileSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return slug || "vex-agent";
}
