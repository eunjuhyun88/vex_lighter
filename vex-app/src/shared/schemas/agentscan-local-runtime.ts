import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const iso = z.string().datetime({ offset: true });
const id = z.string().uuid();

/** Persisted only by main after a signed AgentScan install completes. */
export const localRuntimeBindingFileSchema = z.object({
  schema: z.literal("agentscan.vex.local-runtime-binding/1"),
  agentUid: id,
  versionUid: id,
  bindingUid: id,
  instanceUid: id,
  /** The persistent VEX Publisher Key that signed the cloud install binding. */
  bindingPublisherKeyId: z.string().regex(/^[a-f0-9]{64}$/iu),
  manifestDigest: digest,
  artifactDigest: digest,
}).strict();
export type LocalRuntimeBindingFile = z.infer<typeof localRuntimeBindingFileSchema>;

/**
 * VEX's one built-in local strategy. It is deliberately a closed program,
 * rather than a downloaded AgentScan artifact: it can read one project-bound
 * portfolio snapshot and has no shell, network, filesystem or wallet-write
 * capability.
 */
export const localStrategyKindSchema = z.literal("portfolio_change_summary");
export type LocalStrategyKind = z.infer<typeof localStrategyKindSchema>;

export const localStrategyRuntimeAcquireInputSchema = z.object({
  projectId: id,
  expectedScopeVersion: z.number().int().min(1),
}).strict();
export type LocalStrategyRuntimeAcquireInput = z.infer<typeof localStrategyRuntimeAcquireInputSchema>;

export const localStrategyCapabilitySchema = z.object({
  capabilityId: id,
  strategy: localStrategyKindSchema,
  /** Canonical public AgentScan metadata manifest, never execution authority. */
  manifestDigest: digest,
  /** Digest of VEX's closed built-in executable bundle. */
  runtimeBundleDigest: digest,
  agentUid: id,
  versionUid: id,
  bindingUid: id,
  deploymentUid: id,
  expiresAt: iso,
  localOnly: z.literal(true),
  authority: z.object({
    portfolioRead: z.literal(true),
    walletWrites: z.literal(false),
    trading: z.literal(false),
    secretAccess: z.literal(false),
    remoteExecution: z.literal(false),
  }).strict(),
}).strict();
export type LocalStrategyCapability = z.infer<typeof localStrategyCapabilitySchema>;

export const localStrategyRuntimeAcquireResultSchema = z.union([
  z.object({ outcome: z.literal("granted"), capability: localStrategyCapabilitySchema }).strict(),
  z.object({ outcome: z.enum(["project_not_found", "scope_changed", "agent_binding_invalid", "reporting_unavailable"]) }).strict(),
]);
export type LocalStrategyRuntimeAcquireResult = z.infer<typeof localStrategyRuntimeAcquireResultSchema>;

export const localStrategyRuntimeStartInputSchema = z.object({ capabilityId: id }).strict();
export type LocalStrategyRuntimeStartInput = z.infer<typeof localStrategyRuntimeStartInputSchema>;

export const localStrategySummarySchema = z.object({
  kind: localStrategyKindSchema,
  observedAt: iso,
  walletCount: z.number().int().min(0).max(2),
  liveTotalUsd: z.number().finite(),
  baselineTotalUsd: z.number().finite().nullable(),
  changeUsd: z.number().finite().nullable(),
  changePercent: z.number().finite().nullable(),
  baselineAt: iso.nullable(),
}).strict();
export type LocalStrategySummary = z.infer<typeof localStrategySummarySchema>;

export const localStrategySignedReceiptSchema = z.object({
  alg: z.literal("Ed25519"),
  publicKey: z.string().min(1).max(1024),
  signature: z.string().min(1).max(1024),
  signingPayload: z.object({
    schemaVersion: z.literal("agentscan.local-runtime-receipt/1"),
    action: z.enum(["local_deployment_ack", "local_usage", "local_result"]),
    agentUid: id,
    versionUid: id,
    bindingUid: id,
    artifactDigest: digest,
    manifestDigest: digest,
    runtimeBundleDigest: digest,
  }).passthrough(),
}).strict();
export type LocalStrategySignedReceipt = z.infer<typeof localStrategySignedReceiptSchema>;

export const localStrategyRunSchema = z.object({
  runId: id,
  strategy: localStrategyKindSchema,
  manifestDigest: digest,
  runtimeBundleDigest: digest,
  agentUid: id,
  versionUid: id,
  bindingUid: id,
  deploymentUid: id,
  status: z.enum(["running", "completed", "stopped", "timed_out", "failed", "revoked"]),
  startedAt: iso,
  completedAt: iso.nullable(),
  summary: localStrategySummarySchema.nullable(),
  failure: z.enum(["binding_changed", "portfolio_unavailable", "reporting_unavailable", "execution_failed"]).nullable(),
  receipt: localStrategySignedReceiptSchema.nullable(),
}).strict();
export type LocalStrategyRun = z.infer<typeof localStrategyRunSchema>;

export const localStrategyRuntimeStartResultSchema = z.union([
  z.object({ outcome: z.literal("started"), run: localStrategyRunSchema }).strict(),
  z.object({ outcome: z.literal("run_active"), runId: id }).strict(),
  z.object({ outcome: z.enum(["capability_not_found", "capability_expired", "capability_revoked", "binding_changed"]) }).strict(),
]);
export type LocalStrategyRuntimeStartResult = z.infer<typeof localStrategyRuntimeStartResultSchema>;

export const localStrategyRuntimeGetRunInputSchema = z.object({ runId: id }).strict();
export type LocalStrategyRuntimeGetRunInput = z.infer<typeof localStrategyRuntimeGetRunInputSchema>;
export const localStrategyRuntimeGetRunResultSchema = z.union([
  z.object({ outcome: z.literal("found"), run: localStrategyRunSchema }).strict(),
  z.object({ outcome: z.literal("run_not_found") }).strict(),
]);
export type LocalStrategyRuntimeGetRunResult = z.infer<typeof localStrategyRuntimeGetRunResultSchema>;

export const localStrategyRuntimeStopInputSchema = z.object({ runId: id }).strict();
export type LocalStrategyRuntimeStopInput = z.infer<typeof localStrategyRuntimeStopInputSchema>;
export const localStrategyRuntimeStopResultSchema = z.object({
  outcome: z.enum(["stopped", "already_terminal", "run_not_found"]),
}).strict();
export type LocalStrategyRuntimeStopResult = z.infer<typeof localStrategyRuntimeStopResultSchema>;

export const localStrategyRuntimeRevokeInputSchema = z.object({ capabilityId: id }).strict();
export type LocalStrategyRuntimeRevokeInput = z.infer<typeof localStrategyRuntimeRevokeInputSchema>;
export const localStrategyRuntimeRevokeResultSchema = z.object({
  outcome: z.enum(["revoked", "already_revoked", "capability_not_found"]),
}).strict();
export type LocalStrategyRuntimeRevokeResult = z.infer<typeof localStrategyRuntimeRevokeResultSchema>;
