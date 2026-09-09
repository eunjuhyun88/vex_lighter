import { z } from "zod";

const text = z.string().min(1).max(4096);
const iso = z.string().datetime({ offset: true });
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const publisherKeyId = z.string().regex(/^[a-f0-9]{64}$/iu);
const sourceAttestation = z.object({
  kind: z.literal("vex-studio-public-profile"),
  revisionDigest: digest,
  disclosure: z.literal("publisher_attested"),
}).strict();

export const agentScanManifestSchema = z.object({
  schema: z.literal("agentscan.agent-version/1"),
  agentVersionId: text,
  productId: text,
  name: text,
  version: text,
  creator: text,
  summary: text,
  category: text,
  chain: text,
  signingMode: z.enum(["none", "per_action", "bounded_delegation"]),
  artifactAvailability: z.literal("catalog_reference_only"), executionEnabled: z.literal(false),
  /** Optional catalog identity used only to request a metadata-only install. */
  agentUid: z.string().uuid().nullable().optional(), versionUid: z.string().uuid().nullable().optional(),
  manifestDigest: digest.optional(), artifactDigest: digest.optional(),
  artifactValidationScope: z.literal("vex_attested_digest_only").optional(),
  publicationUid: z.string().uuid().nullable().optional(),
  provenance: z.object({ catalogSource: z.literal("server"), publisherUid: z.string().uuid(), publisherKeyId }).strict().optional(),
  sourceAttestation: sourceAttestation.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.provenance?.catalogSource !== "server") return;
  if (typeof value.agentUid !== "string" || typeof value.versionUid !== "string" || value.manifestDigest === undefined || value.artifactDigest === undefined || value.artifactValidationScope !== "vex_attested_digest_only") {
    ctx.addIssue({ code: "custom", message: "server provenance must include complete catalog identity and digest attestation" });
  }
});
export type AgentScanManifest = z.infer<typeof agentScanManifestSchema>;

export const agentScanInstallPackageSchema = z.object({
  packageSchemaVersion: z.literal("agentscan.install-package/1"),
  version: z.object({ agentUid: z.string().uuid(), versionUid: z.string().uuid(), semver: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u) }).strict(),
  creator: z.object({ publisherUid: z.string().uuid(), publisherKeyId }).strict(),
  manifest: agentScanManifestSchema,
  manifestDigest: digest,
  artifactDigest: digest,
  artifactValidationScope: z.literal("vex_attested_digest_only"),
  executionEnabled: z.literal(false),
}).strict();
export type AgentScanInstallPackage = z.infer<typeof agentScanInstallPackageSchema>;

export const agentScanImportEventSchema = z.object({
  intentId: text,
  state: z.literal("awaiting_review"),
  expiresAt: iso,
}).strict();
export type AgentScanImportEvent = z.infer<typeof agentScanImportEventSchema>;

export const agentScanImportReviewSchema = z.object({
  schema: z.literal("agentscan.vex.import-review/1"),
  intentId: text,
  state: z.literal("awaiting_review"),
  expiresAt: iso,
  sourceOrigin: text,
  manifestDigest: text,
  manifest: agentScanManifestSchema,
}).strict();
export type AgentScanImportReview = z.infer<typeof agentScanImportReviewSchema>;

export const agentScanImportGetPendingInputSchema = z.object({}).strict();
export const agentScanImportPreviewInputSchema = z.object({
  intentId: text,
  projectId: z.string().uuid(),
  expectedScopeVersion: z.number().int().min(1),
}).strict();
export type AgentScanImportPreviewInput = z.infer<typeof agentScanImportPreviewInputSchema>;
export const agentScanImportPreviewSchema = z.object({
  schema: z.literal("agentscan.vex.import-preview/1"),
  intentId: text,
  previewToken: text,
  agentVersionId: text,
  manifestDigest: text,
  project: z.object({
    id: z.string().uuid(), name: text, scopeVersion: z.number().int().min(1),
  }).strict(),
  change: z.object({
    action: z.enum(["create", "no_change", "update_origin"]), relativePath: text,
    /** Set only when an existing canonical binding is being migrated. */
    previousSourceOrigin: text.nullable().optional(),
    walletAccess: z.literal(false), signing: z.literal(false), execution: z.literal(false),
  }).strict(),
}).strict();
export type AgentScanImportPreview = z.infer<typeof agentScanImportPreviewSchema>;
export const agentScanImportConfirmInputSchema = agentScanImportPreviewInputSchema.extend({
  previewToken: text,
}).strict();
export type AgentScanImportConfirmInput = z.infer<typeof agentScanImportConfirmInputSchema>;
const signedBindingPayloadSchema = z.object({
  schema: z.literal("agentscan.vex.binding-receipt/1"),
  receiptId: text, intentId: text, agentVersionId: text, manifestDigest: text,
  projectRef: text, projectRevision: text, bindingRef: text, sourceOrigin: text, issuedAt: iso,
  authority: z.object({
    walletAccess: z.literal(false), signing: z.literal(false), execution: z.literal(false),
  }).strict(),
  mutation: z.object({
    kind: z.literal("project_metadata_binding"), changed: z.boolean(),
  }).strict(),
  cloudInstall: z.object({
    agentUid: z.string().uuid(), versionUid: z.string().uuid(), publisherUid: z.string().uuid(), publisherKeyId,
    manifestDigest: digest, artifactDigest: digest, artifactValidationScope: z.literal("vex_attested_digest_only"), executionEnabled: z.literal(false),
    agentBindingUid: text, instanceUid: text,
  }).strict().optional(),
}).strict();
export const agentScanSignedReceiptSchema = z.object({
  schema: z.literal("agentscan.vex.signed-binding/1"),
  payload: signedBindingPayloadSchema,
  signature: z.object({
    alg: z.literal("Ed25519"), keyId: text, publicKey: text, signature: text,
  }).strict(),
}).strict();
export type AgentScanSignedReceipt = z.infer<typeof agentScanSignedReceiptSchema>;
export const agentScanImportConfirmResultSchema = z.union([
  z.object({
    outcome: z.enum(["approved", "already_approved"]), receipt: agentScanSignedReceiptSchema,
  }).strict(),
  z.object({ outcome: z.enum(["expired", "rejected", "preview_stale"]) }).strict(),
]);
export type AgentScanImportConfirmResult = z.infer<typeof agentScanImportConfirmResultSchema>;
export const agentScanImportRejectInputSchema = z.object({ intentId: text }).strict();
export type AgentScanImportRejectInput = z.infer<typeof agentScanImportRejectInputSchema>;
export const agentScanImportRejectResultSchema = z.object({
  outcome: z.enum(["rejected", "expired", "already_terminal"]),
}).strict();
export type AgentScanImportRejectResult = z.infer<typeof agentScanImportRejectResultSchema>;
