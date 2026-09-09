import { createHash, sign } from "node:crypto";
import { app, safeStorage } from "electron";
import { loadConfig } from "@config/store.js";
import { getReportingState } from "@vex-agent/db/repos/agentscan-reporting.js";
import { resolveAgentscanBaseUrl } from "@vex-agent/sync/agentscan-report/production-deps.js";
import { createPublisherClient, installPackageMatchesManifest } from "./publisher-client.js";
import { createPublisherKeyStore, type PublisherKey } from "./publisher-key-store.js";
import type { PublicationReceipt, PublicationRequest } from "@shared/schemas/agentscan-publication.js";
import type { AgentScanManifest } from "@shared/schemas/agentscan-import.js";
import type { LocalStrategyBinding, LocalStrategySummary } from "./local-strategy-runtime.js";
import {
  healthMatchesRuntime,
  PUBLIC_RUNTIME_BUNDLE_DECLARATION,
  PUBLIC_RUNTIME_BUNDLE_DIGEST,
  publicRuntimeEndpoints,
} from "./public-runtime.js";
import { stableStringify } from "./stable-json.js";
import { publicationManifestDigest } from "./publication-intents.js";

let publisherKeys: ReturnType<typeof createPublisherKeyStore> | null = null;
function publisherKeyStore(): ReturnType<typeof createPublisherKeyStore> {
  // `src/main/index.ts` remaps Electron userData during bootstrap. Resolving
  // the path at module evaluation can run before that remap because ESM
  // dependencies are evaluated first, splitting one permanent identity across
  // Electron's legacy default directory and VEX's configured state directory.
  publisherKeys ??= createPublisherKeyStore({ userDataPath: app.getPath("userData"), safeStorage });
  return publisherKeys;
}
const signPayload = (key: PublisherKey, payload: string): string => sign(null, Buffer.from(payload, "utf8"), key.privateKey).toString("base64url");
const ARTIFACT_VALIDATION_SCOPE = "vex_attested_digest_only" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUNTIME_RECEIPT_SCHEMA = "agentscan.local-runtime-receipt/1" as const;
export function installIdempotencyKey(intentId: string): string {
  const hex = createHash("sha256").update(`vex:agentscan:install:${intentId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function ready() {
  const [state, baseUrl] = await Promise.all([
    getReportingState(), Promise.resolve(resolveAgentscanBaseUrl(loadConfig().services.agentscanApiUrl)),
  ]);
  if (state.ingestToken === null || baseUrl === null) return null;
  const key = await publisherKeyStore().getOrCreate();
  return { key, client: createPublisherClient(baseUrl, state.ingestToken) };
}

function localReceipt(key: PublisherKey, signingPayload: Record<string, unknown>) {
  return {
    alg: "Ed25519" as const,
    publicKey: key.publicKey,
    signature: signPayload(key, stableStringify(signingPayload)),
    signingPayload,
  };
}

function localDeploymentId(binding: LocalStrategyBinding): string {
  return `vex:${createHash("sha256")
    .update(`${binding.bindingUid}\n${binding.manifestDigest}\n${binding.runtimeBundleDigest}`, "utf8")
    .digest("hex")}`;
}

async function runtimeContext() {
  const context = await ready();
  if (context === null) throw new Error("agentscan_reporting_not_ready");
  const publisher = await context.client.register(context.key.publicKey, (payload) => signPayload(context.key, payload));
  if (publisher.publisherKeyId !== context.key.keyId) throw new Error("publisher_key_id_mismatch");
  return context;
}

/** Proves the current permanent VEX Publisher Key is still AgentScan-active. */
export async function activeRuntimeBindingPublisherKeyId(): Promise<string> {
  const context = await runtimeContext();
  return context.key.keyId;
}

async function verifyPublicRuntime(origin: string): Promise<{ endpoint: string; healthEndpoint: string }> {
  const endpoints = publicRuntimeEndpoints(origin);
  if (endpoints === null) throw new Error("public_runtime_endpoint_invalid");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(endpoints.healthEndpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("public_runtime_health_unavailable");
    const health: unknown = await response.json();
    if (!healthMatchesRuntime(health, {
      bundleVersion: PUBLIC_RUNTIME_BUNDLE_DECLARATION.bundleVersion,
      runtimeBundleDigest: PUBLIC_RUNTIME_BUNDLE_DIGEST,
    })) throw new Error("public_runtime_health_invalid");
    return endpoints;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Acknowledge an already-deployed public runtime only after its health endpoint
 * proves the exact audited Node 24 bundle. This never deploys or invokes it.
 */
export async function acknowledgeVercelRuntimeDeployment(
  binding: LocalStrategyBinding,
  origin: string,
  vercelDeploymentId: string,
): Promise<{ deploymentUid: string; endpoint: string; healthEndpoint: string; runtimeBundleDigest: string; status: "ready" | "active" }> {
  const endpoints = await verifyPublicRuntime(origin);
  const context = await runtimeContext();
  const signingPayload = {
    schemaVersion: "agentscan.vercel-runtime-receipt/1",
    action: "vercel_deployment_ack" as const,
    verifiedAt: new Date().toISOString(),
    vercelDeploymentId,
    endpoint: endpoints.endpoint,
    healthEndpoint: endpoints.healthEndpoint,
    status: "ready" as const,
    agentUid: binding.agentUid,
    versionUid: binding.versionUid,
    bindingUid: binding.bindingUid,
    executionEnabled: true as const,
    manifestDigest: binding.manifestDigest,
    artifactDigest: binding.artifactDigest,
    runtimeBundleDigest: PUBLIC_RUNTIME_BUNDLE_DIGEST,
  };
  const result = await context.client.acknowledgeVercelDeployment({
    schemaVersion: "agentscan.vercel-deployment-ack/1",
    agentUid: binding.agentUid,
    versionUid: binding.versionUid,
    bindingUid: binding.bindingUid,
    vercelDeploymentId,
    endpoint: endpoints.endpoint,
    healthEndpoint: endpoints.healthEndpoint,
    status: "ready",
    manifestDigest: binding.manifestDigest,
    artifactDigest: binding.artifactDigest,
    runtimeBundleDigest: PUBLIC_RUNTIME_BUNDLE_DIGEST,
    receipt: localReceipt(context.key, signingPayload),
  });
  if (result.endpoint !== endpoints.endpoint || result.healthEndpoint !== endpoints.healthEndpoint || result.runtimeBundleDigest !== PUBLIC_RUNTIME_BUNDLE_DIGEST) throw new Error("vercel_runtime_response_invalid");
  return result;
}

/**
 * AgentScan local-runtime reporting. The persistent, OS-encrypted Publisher
 * Key signs every receipt. The public catalog artifact digest is carried
 * unchanged; executable bundle attestation remains a separate digest.
 */
export async function acknowledgeLocalRuntimeDeployment(binding: LocalStrategyBinding): Promise<{
  deploymentUid: string;
  receipt: { alg: "Ed25519"; publicKey: string; signature: string; signingPayload: Record<string, unknown> };
}> {
  const context = await runtimeContext();
  const localDeployment = localDeploymentId(binding);
  const signingPayload = {
    schemaVersion: RUNTIME_RECEIPT_SCHEMA,
    action: "local_deployment_ack" as const,
    approvedAt: new Date().toISOString(),
    localDeploymentId: localDeployment,
    agentUid: binding.agentUid,
    versionUid: binding.versionUid,
    bindingUid: binding.bindingUid,
    executionEnabled: true as const,
    manifestDigest: binding.manifestDigest,
    artifactDigest: binding.artifactDigest,
    runtimeBundleDigest: binding.runtimeBundleDigest,
  };
  const receipt = localReceipt(context.key, signingPayload);
  const result = await context.client.acknowledgeLocalDeployment({
    agentUid: binding.agentUid,
    versionUid: binding.versionUid,
    bindingUid: binding.bindingUid,
    localDeploymentId: localDeployment,
    manifestDigest: binding.manifestDigest,
    artifactDigest: binding.artifactDigest,
    runtimeBundleDigest: binding.runtimeBundleDigest,
    receipt,
  });
  if (result.agentUid !== binding.agentUid || result.versionUid !== binding.versionUid || result.manifestDigest !== binding.manifestDigest || result.artifactDigest !== binding.artifactDigest || result.runtimeBundleDigest !== binding.runtimeBundleDigest) throw new Error("local_runtime_response_invalid");
  return { deploymentUid: result.deploymentUid, receipt: result.receipt as ReturnType<typeof localReceipt> };
}

export async function startLocalRuntimeRun(input: {
  binding: LocalStrategyBinding;
  deploymentUid: string;
  runId: string;
  inputSnapshotDigest: string;
}): Promise<void> {
  const context = await runtimeContext();
  const signingPayload = {
    schemaVersion: RUNTIME_RECEIPT_SCHEMA,
    action: "local_usage" as const,
    startedAt: new Date().toISOString(),
    runId: input.runId,
    deploymentUid: input.deploymentUid,
    inputSnapshotDigest: input.inputSnapshotDigest,
    agentUid: input.binding.agentUid,
    versionUid: input.binding.versionUid,
    bindingUid: input.binding.bindingUid,
    executionEnabled: true as const,
    manifestDigest: input.binding.manifestDigest,
    artifactDigest: input.binding.artifactDigest,
    runtimeBundleDigest: input.binding.runtimeBundleDigest,
  };
  const result = await context.client.startLocalRun({
    agentUid: input.binding.agentUid,
    versionUid: input.binding.versionUid,
    bindingUid: input.binding.bindingUid,
    deploymentUid: input.deploymentUid,
    runId: input.runId,
    inputSnapshotDigest: input.inputSnapshotDigest,
    manifestDigest: input.binding.manifestDigest,
    artifactDigest: input.binding.artifactDigest,
    runtimeBundleDigest: input.binding.runtimeBundleDigest,
    receipt: localReceipt(context.key, signingPayload),
  });
  if (result.runId !== input.runId || result.deploymentUid !== input.deploymentUid || result.inputSnapshotDigest !== input.inputSnapshotDigest) throw new Error("local_runtime_response_invalid");
}

export async function completeLocalRuntimeRun(input: {
  binding: LocalStrategyBinding;
  deploymentUid: string;
  runId: string;
  summary: LocalStrategySummary;
}): Promise<{ alg: "Ed25519"; publicKey: string; signature: string; signingPayload: Record<string, unknown> }> {
  const context = await runtimeContext();
  const bytes = Buffer.from(stableStringify(input.summary), "utf8");
  const artifact = {
    artifactDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteLength: bytes.byteLength,
    contentType: "application/json",
    producedAt: input.summary.observedAt,
  };
  const signingPayload = {
    schemaVersion: RUNTIME_RECEIPT_SCHEMA,
    action: "local_result" as const,
    completedAt: new Date().toISOString(),
    runId: input.runId,
    deploymentUid: input.deploymentUid,
    resultArtifact: artifact,
    agentUid: input.binding.agentUid,
    versionUid: input.binding.versionUid,
    bindingUid: input.binding.bindingUid,
    executionEnabled: true as const,
    manifestDigest: input.binding.manifestDigest,
    artifactDigest: input.binding.artifactDigest,
    runtimeBundleDigest: input.binding.runtimeBundleDigest,
  };
  const result = await context.client.completeLocalRun({
    runId: input.runId,
    artifact,
    receipt: localReceipt(context.key, signingPayload),
  });
  if (result.runId !== input.runId) throw new Error("local_runtime_response_invalid");
  return result.receipt as ReturnType<typeof localReceipt>;
}
function listingReceiptValues(input: PublicationRequest, listing: Record<string, unknown>, publisher: { publisherUid: string; publisherKeyId: string }, intentId: string, local?: { localIntentId: string; profileRevisionDigest: string }): PublicationReceipt["payload"] {
  const agent = listing.agent;
  const version = listing.version;
  const creator = listing.creator;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent) || typeof version !== "object" || version === null || Array.isArray(version) || typeof creator !== "object" || creator === null || Array.isArray(creator)) throw new Error("publication_listing_invalid");
  const agentRecord = agent as Record<string, unknown>;
  const versionRecord = version as Record<string, unknown>;
  const creatorRecord = creator as Record<string, unknown>;
  const agentUid = agentRecord.agentUid;
  const versionUid = versionRecord.versionUid;
  const publisherUid = creatorRecord.publisherUid;
  const listedPublisherKeyId = creatorRecord.publisherKeyId;
  const topRemix = Object.hasOwn(listing, "remixOfVersionUid") ? listing.remixOfVersionUid : undefined;
  const versionRemix = Object.hasOwn(versionRecord, "remixOfVersionUid") ? versionRecord.remixOfVersionUid : undefined;
  if (topRemix !== undefined && versionRemix !== undefined && topRemix !== versionRemix) throw new Error("publication_listing_invalid");
  const listedRemix = versionRemix !== undefined ? versionRemix : topRemix;
  const requestedRemix = input.remixOfVersionUid ?? null;
  if ((listedRemix === undefined ? null : listedRemix) !== requestedRemix || typeof listedRemix === "string" && !UUID.test(listedRemix)) throw new Error("publication_listing_invalid");
  const topParent = Object.hasOwn(listing, "parentVersionUid") ? listing.parentVersionUid : undefined;
  const versionParent = Object.hasOwn(versionRecord, "parentVersionUid") ? versionRecord.parentVersionUid : undefined;
  if (topParent !== undefined && versionParent !== undefined && topParent !== versionParent) throw new Error("publication_listing_invalid");
  const listedParent = versionParent !== undefined ? versionParent : topParent;
  if ((listedParent === undefined ? null : listedParent) !== (input.parentVersionUid ?? null) || typeof listedParent === "string" && !UUID.test(listedParent)) throw new Error("publication_listing_invalid");
  if (![agentUid, versionUid, publisherUid].every((value) => typeof value === "string" && UUID.test(value)) || input.agent.agentUid !== undefined && agentUid !== input.agent.agentUid || publisherUid !== publisher.publisherUid || typeof listedPublisherKeyId !== "string" || !/^[a-f0-9]{64}$/iu.test(listedPublisherKeyId) || listedPublisherKeyId !== publisher.publisherKeyId) throw new Error("publication_listing_invalid");
  if (versionRecord.semver !== input.version.semver || versionRecord.manifestDigest !== input.version.manifestDigest || versionRecord.artifactDigest !== input.version.artifactDigest || versionRecord.artifactValidationScope !== ARTIFACT_VALIDATION_SCOPE || versionRecord.executionEnabled !== false) throw new Error("publication_listing_invalid");
  const listingUid = listingRecordValue(listing, "listingUid");
  if (local && (listingUid === undefined || !UUID.test(listingUid))) throw new Error("publication_listing_invalid");
  return { schema: "agentscan.vex.publication-receipt/1", intentId, ...(local ? { localIntentId: local.localIntentId, listingUid, profileRevisionDigest: local.profileRevisionDigest } : {}), agentUid: agentUid as string, versionUid: versionUid as string, publisherUid: publisherUid as string, publisherKeyId: listedPublisherKeyId as string, parentVersionUid: input.parentVersionUid ?? null, remixOfVersionUid: requestedRemix, artifactValidationScope: ARTIFACT_VALIDATION_SCOPE, executionEnabled: false, manifestDigest: input.version.manifestDigest, artifactDigest: input.version.artifactDigest };
}
function listingRecordValue(listing: Record<string, unknown>, key: string): string | undefined {
  const value = listing[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function signedReceipt(input: PublicationRequest, listing: Record<string, unknown>, publisher: { publisherUid: string; publisherKeyId: string }, intentId: string, key: PublisherKey, local?: { localIntentId: string; profileRevisionDigest: string }): PublicationReceipt {
  const payload = listingReceiptValues(input, listing, publisher, intentId, local);
  return { schema: "agentscan.vex.signed-publication/1", payload, signature: { alg: "Ed25519", keyId: key.keyId, publicKey: key.publicKey, signature: signPayload(key, stableStringify(payload)) } };
}
/** Call only after the Studio confirmation has committed its confined public
 * manifest file. No source code or execution permission is sent to AgentScan. */
export async function completeManifestOnlyPublication(input: PublicationRequest, expectedPublisherKeyId?: string, local?: { localIntentId: string; profileRevisionDigest: string }): Promise<{ intentId: string; status: "completed"; listing: Record<string, unknown>; receipt: PublicationReceipt }> {
  // An initial local publication has no saved identity (and therefore no
  // expected key id) yet. Updates do have one. A key expectation without the
  // local receipt binding is the only invalid combination.
  if (expectedPublisherKeyId !== undefined && local === undefined) throw new Error("local_receipt_context_invalid");
  const digest = publicationManifestDigest(input);
  if (input.version.manifest.schemaVersion !== "agentscan.strategy-manifest/1" || input.version.manifest.executionEnabled !== false || input.version.manifestDigest !== digest || input.version.artifactDigest !== digest) throw new Error("publication_manifest_refused");
  const context = await ready();
  if (context === null) throw new Error("agentscan_reporting_not_ready");
  const publisher = await context.client.register(context.key.publicKey, (payload) => signPayload(context.key, payload));
  if (publisher.publisherKeyId !== context.key.keyId) throw new Error("publisher_key_id_mismatch");
  if (expectedPublisherKeyId !== undefined && publisher.publisherKeyId !== expectedPublisherKeyId) throw new Error("publisher_key_drift");
  const started = await context.client.startPublication({ publisherKey: publisher.publicKey, idempotencyKey: input.idempotencyKey, agent: input.agent, version: input.version, ...(input.parentVersionUid ? { parentVersionUid: input.parentVersionUid } : {}), ...(input.remixOfVersionUid ? { remixOfVersionUid: input.remixOfVersionUid } : {}) });
  if (started.status === "completed") {
    const listing = started.listing;
    return { ...started, receipt: signedReceipt(input, listing, publisher, started.intentId, context.key, local) };
  }
  if (input.parentVersionUid !== undefined && started.parentVersionUid !== input.parentVersionUid) throw new Error("publication_parent_mismatch");
  const publication = await context.client.completePublication(started.intentId, signPayload(context.key, started.signingPayload));
  const listing = publication.listing;
  return { ...publication, receipt: signedReceipt(input, listing, publisher, started.intentId, context.key, local) };
}
/** The import owner calls this only after its existing local confirmation. */
export async function completeSignedInstall(manifest: AgentScanManifest, importIntentId: string): Promise<{ intentId: string; status: "completed"; agentUid: string; versionUid: string; publisherUid: string; publisherKeyId: string; bindingPublisherKeyId: string; manifestDigest: string; artifactDigest: string; artifactValidationScope: "vex_attested_digest_only"; executionEnabled: false; agentBindingUid: string; instanceUid: string }> {
  const provenance = manifest.provenance;
  if (typeof manifest.agentUid !== "string" || typeof manifest.versionUid !== "string" || typeof manifest.manifestDigest !== "string" || typeof manifest.artifactDigest !== "string" || manifest.artifactValidationScope !== ARTIFACT_VALIDATION_SCOPE || manifest.executionEnabled !== false || provenance?.catalogSource !== "server" || typeof provenance.publisherUid !== "string" || typeof provenance.publisherKeyId !== "string") throw new Error("install_manifest_invalid");
  const context = await ready();
  if (context === null) throw new Error("agentscan_reporting_not_ready");
  const publisher = await context.client.register(context.key.publicKey, (payload) => signPayload(context.key, payload));
  if (publisher.publisherKeyId !== context.key.keyId) throw new Error("publisher_key_id_mismatch");
  const started = await context.client.startInstall(publisher.publicKey, manifest.versionUid, installIdempotencyKey(importIntentId));
  const installPackage = started.installPackage;
  if (!installPackageMatchesManifest(installPackage, manifest)) throw new Error("install_package_mismatch");
  const completed = await context.client.completeInstall(started.intentId, signPayload(context.key, started.signingPayload));
  return { ...completed, agentUid: installPackage.version.agentUid, versionUid: installPackage.version.versionUid, publisherUid: installPackage.creator.publisherUid, publisherKeyId: installPackage.creator.publisherKeyId, bindingPublisherKeyId: publisher.publisherKeyId, manifestDigest: installPackage.manifestDigest, artifactDigest: installPackage.artifactDigest, artifactValidationScope: installPackage.artifactValidationScope };
}
