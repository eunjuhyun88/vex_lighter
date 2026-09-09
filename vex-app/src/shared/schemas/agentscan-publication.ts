import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const text = (max: number) => z.string().min(1).max(max);
const uuid = z.string().uuid();

const secretKey = /(secret|password|private[_.-]?key|seed|mnemonic|token|authorization|cookie|credential|api[_.-]?key)/iu;
// Catch credentials even when they are placed under an otherwise harmless
// public field. Generic base64 and long strings are intentionally allowed.
const obviousSecretValue = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\b(?:sk|ghp|xox[abprs])_[A-Za-z0-9_-]{12,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u,
];
function safeString(value: string): boolean { return !obviousSecretValue.some((pattern) => pattern.test(value)); }
function safeValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => safeValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([key, item]) => key.length <= 80 && !secretKey.test(key) && safeValue(item, depth + 1));
}

/** The only object a browser may submit for VEX publication review. */
export const strategyManifestSchema = z.object({
  schemaVersion: z.literal("agentscan.strategy-manifest/1"),
  name: text(120),
  summary: z.string().max(500),
  capabilities: z.array(text(64)).max(16),
  inputs: z.array(z.object({ name: text(64), description: z.string().max(240), required: z.boolean() }).strict()).max(32),
  outputs: z.array(z.object({ name: text(64), description: z.string().max(240) }).strict()).max(32),
  executionEnabled: z.literal(false),
  strategy: z.record(z.string().max(80), z.unknown()),
  sourceAttestation: z.object({ kind: z.literal("vex-studio-public-profile"), revisionDigest: digest, disclosure: z.literal("publisher_attested") }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (!safeValue(value) || JSON.stringify(value).length > 64_000) ctx.addIssue({ code: "custom", message: "unsafe or oversized strategy manifest" });
});
export type StrategyManifest = z.infer<typeof strategyManifestSchema>;

/**
 * The only on-disk source accepted by VEX's local publication exporter.
 * `manifest` is the public, non-executable declaration; versioning is kept in
 * this wrapper so the AgentScan strategy manifest remains wire-compatible.
 * No project id, source path, wallet, credential or executable artifact is
 * representable here.
 */
export const localAgentPublicProfileSchema = z.object({
  schema: z.literal("agentscan.vex.agent-public/1"),
  semver: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
  // Attestation is exporter-owned. A hand-edited profile may not smuggle in
  // a stale claim that VEX would then hash and overwrite.
  manifest: strategyManifestSchema.superRefine((value, ctx) => {
    if (Object.hasOwn(value, "sourceAttestation")) ctx.addIssue({ code: "custom", path: ["sourceAttestation"], message: "sourceAttestation is exporter-owned" });
  }),
}).strict();
export type LocalAgentPublicProfile = z.infer<typeof localAgentPublicProfileSchema>;

/** Metadata used to continue an existing AgentScan Agent identity. */
export const localAgentIdentitySchema = z.object({
  schema: z.literal("agentscan.vex.agent-identity/1"),
  agentUid: uuid,
  latestVersionUid: uuid,
  semver: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
  publisherKeyId: z.string().regex(/^[a-f0-9]{64}$/iu),
  listingUid: uuid,
  profileRevisionDigest: digest,
  manifestDigest: digest,
}).strict();
export type LocalAgentIdentity = z.infer<typeof localAgentIdentitySchema>;

/** Renderer-owned form values; main turns these into the canonical profile. */
export const localAgentPublicProfileDraftSchema = z.object({
  name: text(120), summary: z.string().max(500), semver: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
  capabilities: z.array(text(64)).max(16),
  inputs: z.array(z.object({ name: text(64), description: z.string().max(240), required: z.boolean() }).strict()).max(32),
  outputs: z.array(z.object({ name: text(64), description: z.string().max(240) }).strict()).max(32),
}).strict();
export type LocalAgentPublicProfileDraft = z.infer<typeof localAgentPublicProfileDraftSchema>;

const agentSchema = z.object({
  agentUid: uuid.optional(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80).optional(),
  displayName: text(120).optional(),
  summary: z.string().max(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.agentUid && (value.slug || value.displayName || value.summary !== undefined)) ctx.addIssue({ code: "custom", message: "existing agent metadata is immutable" });
  if (!value.agentUid && (!value.slug || !value.displayName || value.summary === undefined)) ctx.addIssue({ code: "custom", message: "new agent metadata is required" });
});
export type PublicationAgent = z.infer<typeof agentSchema>;

const versionSchema = z.object({
  semver: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
  manifest: strategyManifestSchema,
  manifestDigest: digest,
  artifactDigest: digest,
}).strict();
export type PublicationVersion = z.infer<typeof versionSchema>;

export const publicationRequestSchema = z.object({
  schema: z.literal("agentscan.vex.publication-request/1"),
  idempotencyKey: uuid,
  agent: agentSchema,
  version: versionSchema,
  /** Exact server version being advanced; absent only for a new agent. */
  parentVersionUid: uuid.optional(),
  remixOfVersionUid: uuid.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.remixOfVersionUid && value.agent.agentUid) ctx.addIssue({ code: "custom", path: ["agent", "agentUid"], message: "a fork must create a new agent identity" });
  if (value.parentVersionUid && !value.agent.agentUid) ctx.addIssue({ code: "custom", path: ["parentVersionUid"], message: "an update parent requires an existing agent identity" });
  if (value.parentVersionUid && value.remixOfVersionUid) ctx.addIssue({ code: "custom", path: ["parentVersionUid"], message: "an update cannot also be a fork" });
});
export type PublicationRequest = z.infer<typeof publicationRequestSchema>;

/** Browser launch signal for the local-first VEX export path. */
export const localPublicationLaunchRequestSchema = z.object({
  schema: z.literal("agentscan.local-publication-launch/1"),
  idempotencyKey: uuid,
}).strict();
export type LocalPublicationLaunchRequest = z.infer<typeof localPublicationLaunchRequestSchema>;

export const publicationIntentEventSchema = z.object({
  intentId: text(160), state: z.literal("awaiting_review"), expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type PublicationIntentEvent = z.infer<typeof publicationIntentEventSchema>;

export const publicationIntentReviewSchema = z.object({
  schema: z.literal("agentscan.vex.publication-review/1"),
  intentId: text(160), state: z.literal("awaiting_review"), expiresAt: z.string().datetime({ offset: true }),
  sourceOrigin: text(512), mode: z.enum(["browser_request", "local_project"]), request: publicationRequestSchema.nullable(),
}).strict();
export type PublicationIntentReview = z.infer<typeof publicationIntentReviewSchema>;

export const publicationPreviewInputSchema = z.object({
  intentId: text(160), projectId: uuid, expectedScopeVersion: z.number().int().min(1), profile: localAgentPublicProfileDraftSchema.optional(),
}).strict();
export type PublicationPreviewInput = z.infer<typeof publicationPreviewInputSchema>;
export const publicationPreviewSchema = z.object({
  schema: z.literal("agentscan.vex.publication-preview/1"), intentId: text(160), previewToken: text(160),
  manifestDigest: digest, artifactDigest: digest, manifestJson: text(64_000), profileJson: text(64_000).optional(), relativePath: text(512),
  project: z.object({ id: uuid, name: text(80), scopeVersion: z.number().int().min(1) }).strict(),
  action: z.enum(["create", "no_change"]),
}).strict();
export type PublicationPreview = z.infer<typeof publicationPreviewSchema>;
export const publicationConfirmInputSchema = publicationPreviewInputSchema.extend({ previewToken: text(160) }).strict();
export type PublicationConfirmInput = z.infer<typeof publicationConfirmInputSchema>;
const listingSchema = z.record(z.string(), z.unknown());
export const publicationReceiptSchema = z.object({
  schema: z.literal("agentscan.vex.signed-publication/1"),
  payload: z.object({
    schema: z.literal("agentscan.vex.publication-receipt/1"), intentId: text(160), localIntentId: text(160).optional(), listingUid: text(160).optional(), profileRevisionDigest: digest.optional(),
    agentUid: uuid, versionUid: uuid, publisherUid: uuid, publisherKeyId: text(64),
    parentVersionUid: uuid.nullable(), remixOfVersionUid: uuid.nullable(),
    artifactValidationScope: z.literal("vex_attested_digest_only"), executionEnabled: z.literal(false),
    manifestDigest: digest, artifactDigest: digest,
  }).strict(),
  signature: z.object({ alg: z.literal("Ed25519"), keyId: text(64), publicKey: text(128), signature: text(128) }).strict(),
}).strict();
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;
export const publicationResultSchema = z.object({
  outcome: z.enum(["approved", "already_approved"]),
  publication: z.object({
    intentId: text(160), status: z.literal("completed"), listing: listingSchema, receipt: publicationReceiptSchema,
  }).strict(),
}).strict();
export type PublicationResult = z.infer<typeof publicationResultSchema>;
export const publicationFailureCodeSchema = z.enum([
  "unavailable",
  "unauthorized",
  "invalid_response",
  "rejected",
  "not_ready",
  "publisher_key_mismatch",
  "internal",
]);
export type PublicationFailureCode = z.infer<typeof publicationFailureCodeSchema>;
export const publicationTerminalSchema = z.union([
  z.object({ outcome: z.enum(["expired", "rejected", "preview_stale"]) }).strict(),
  z.object({
    outcome: z.literal("failed"),
    failure: z.object({ code: publicationFailureCodeSchema }).strict(),
  }).strict(),
]);
export const publicationConfirmResultSchema = z.union([publicationResultSchema, publicationTerminalSchema]);
export type PublicationConfirmResult = z.infer<typeof publicationConfirmResultSchema>;
export const publicationRejectInputSchema = z.object({ intentId: text(160) }).strict();
export const publicationRejectResultSchema = z.object({ outcome: z.enum(["rejected", "expired", "already_terminal"]) }).strict();
export type PublicationRejectResult = z.infer<typeof publicationRejectResultSchema>;

export const publicationStatusSchema = z.object({
  schema: z.literal("agentscan.vex.publication-status/1"), intentId: text(160),
  state: z.enum(["awaiting_review", "approved", "rejected", "expired", "failed"]),
  expiresAt: z.string().datetime({ offset: true }),
  receipt: publicationReceiptSchema.optional(), listing: listingSchema.optional(),
  error: z.string().max(256).optional(),
}).strict();
export type PublicationStatus = z.infer<typeof publicationStatusSchema>;
