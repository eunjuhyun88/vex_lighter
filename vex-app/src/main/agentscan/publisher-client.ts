/** Exact AgentScan creator protocol. `payload` is signed byte-for-byte. */
import { createHash } from "node:crypto";
import { readJson } from "@utils/http.js";
import { agentScanInstallPackageSchema, type AgentScanInstallPackage } from "@shared/schemas/agentscan-import.js";
import type { AgentScanManifest } from "@shared/schemas/agentscan-import.js";
import { stableStringify } from "./stable-json.js";

type ApiRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is ApiRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v);
function localReceipt(value: unknown): ApiRecord | null {
  if (!isRecord(value) || value.alg !== "Ed25519" || !string(value.publicKey) || !string(value.signature) || !isRecord(value.signingPayload)) return null;
  // AgentScan also returns its server-side receipt digest. Keep the renderer
  // boundary limited to the signed material VEX actually verifies and shows.
  return {
    alg: "Ed25519",
    publicKey: value.publicKey,
    signature: value.signature,
    signingPayload: value.signingPayload,
  };
}
export class PublisherApiError extends Error { constructor(readonly code: "unavailable" | "unauthorized" | "invalid_response" | "rejected") { super(code); } }
function publisherKeyId(publicKey: string): string | null {
  try {
    const raw = Buffer.from(publicKey, "base64url");
    return raw.byteLength === 32 ? createHash("sha256").update(raw).digest("hex") : null;
  } catch { return null; }
}
/** The package author may differ from VEX's installer authorization key. */
export function installPackageMatchesManifest(installPackage: AgentScanInstallPackage, manifest: AgentScanManifest): boolean {
  const provenance = manifest.provenance;
  return typeof manifest.agentUid === "string" && typeof manifest.versionUid === "string" && typeof manifest.manifestDigest === "string" && typeof manifest.artifactDigest === "string" && manifest.artifactValidationScope === "vex_attested_digest_only" && manifest.executionEnabled === false && provenance?.catalogSource === "server" && installPackage.version.agentUid === manifest.agentUid && installPackage.version.versionUid === manifest.versionUid && installPackage.version.semver === manifest.version && installPackage.creator.publisherUid === provenance.publisherUid && installPackage.creator.publisherKeyId === provenance.publisherKeyId && installPackage.manifestDigest === manifest.manifestDigest && installPackage.artifactDigest === manifest.artifactDigest && installPackage.artifactValidationScope === "vex_attested_digest_only" && installPackage.executionEnabled === false && stableStringify(installPackage.manifest) === stableStringify(manifest);
}
export function createPublisherClient(baseUrl: string, bearer: string, fetcher: typeof fetch = fetch) {
  const post = async (path: string, body: unknown): Promise<ApiRecord> => {
    let response: Response;
    try { response = await fetcher(new URL(path.replace(/^\//u, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }); }
    catch { throw new PublisherApiError("unavailable"); }
    if (response.status === 401) throw new PublisherApiError("unauthorized");
    if (!response.ok) throw new PublisherApiError(response.status === 429 || response.status >= 500 ? "unavailable" : "rejected");
    const value = await readJson(response).catch(() => null);
    if (!isRecord(value)) throw new PublisherApiError("invalid_response");
    return value;
  };
  return {
    async register(publicKey: string, sign: (payload: string) => string) {
      const expectedKeyId = publisherKeyId(publicKey);
      if (expectedKeyId === null) throw new PublisherApiError("invalid_response");
      const challenge = await post("/api/v1/creator/publisher-keys/challenge", { publicKey });
      if (!string(challenge.challengeId) || !string(challenge.signingPayload) || !string(challenge.expiresAt)) throw new PublisherApiError("invalid_response");
      const result = await post("/api/v1/creator/publisher-keys/register", { challengeId: challenge.challengeId, signature: sign(challenge.signingPayload) });
      if (!string(result.publisherUid) || result.publicKey !== publicKey || result.publisherKeyId !== expectedKeyId) throw new PublisherApiError("invalid_response");
      return { publisherUid: result.publisherUid, publicKey, publisherKeyId: expectedKeyId };
    },
    async startPublication(input: ApiRecord) {
      const result = await post("/api/v1/creator/publication-intents/start", input);
      if (result.status === "completed") {
        if (!string(result.intentId) || !isRecord(result.listing)) throw new PublisherApiError("invalid_response");
        return result as { intentId: string; status: "completed"; listing: ApiRecord };
      }
      if (!string(result.intentId) || !string(result.agentUid) || !string(result.versionUid) || !string(result.signingPayload) || !string(result.expiresAt)) throw new PublisherApiError("invalid_response");
      return { intentId: result.intentId, status: "pending" as const, agentUid: result.agentUid, versionUid: result.versionUid, signingPayload: result.signingPayload, expiresAt: result.expiresAt, ...(string(result.parentVersionUid) ? { parentVersionUid: result.parentVersionUid } : {}) };
    },
    async completePublication(intentId: string, signature: string) {
      const result = await post("/api/v1/creator/publication-intents/complete", { intentId, signature });
      if (result.intentId !== intentId || result.status !== "completed" || !isRecord(result.listing)) throw new PublisherApiError("invalid_response");
      return { intentId, status: "completed" as const, listing: result.listing };
    },
    async startInstall(publisherKey: string, versionUid: string, idempotencyKey: string) {
      const result = await post("/api/v1/install-intents/start", { publisherKey, versionUid, idempotencyKey });
      const parsedPackage = agentScanInstallPackageSchema.safeParse(result.installPackage);
      if (!string(result.intentId) || !string(result.signingPayload) || !string(result.expiresAt) || !parsedPackage.success) throw new PublisherApiError("invalid_response");
      return { intentId: result.intentId, signingPayload: result.signingPayload, expiresAt: result.expiresAt, installPackage: parsedPackage.data as AgentScanInstallPackage };
    },
    async completeInstall(intentId: string, signature: string) {
      const result = await post("/api/v1/install-intents/complete", { intentId, signature });
      if (result.intentId !== intentId || result.status !== "completed" || !string(result.agentBindingUid) || !string(result.instanceUid) || result.executionEnabled !== false) throw new PublisherApiError("invalid_response");
      return { intentId, status: "completed" as const, agentBindingUid: result.agentBindingUid, instanceUid: result.instanceUid, executionEnabled: false as const };
    },
    /** AgentScan's local-runtime contract: all callers supply a main-signed receipt. */
    async acknowledgeLocalDeployment(input: ApiRecord) {
      const result = await post("/api/v1/local-runtime/deployments/ack", {
        ...input,
        schemaVersion: "agentscan.local-deployment-ack/1",
      });
      const receipt = localReceipt(result.deploymentReceipt);
      if (!uuid(result.agentUid) || !uuid(result.versionUid) || !uuid(result.deploymentUid) || !digest(result.manifestDigest) || !digest(result.artifactDigest) || !digest(result.runtimeBundleDigest) || result.status !== "active" || receipt === null) throw new PublisherApiError("invalid_response");
      return { agentUid: result.agentUid, versionUid: result.versionUid, deploymentUid: result.deploymentUid, manifestDigest: result.manifestDigest, artifactDigest: result.artifactDigest, runtimeBundleDigest: result.runtimeBundleDigest, receipt };
    },
    async startLocalRun(input: ApiRecord) {
      const result = await post("/api/v1/local-runtime/runs/start", {
        ...input,
        schemaVersion: "agentscan.local-run-start/1",
      });
      if (!uuid(result.runId) || !uuid(result.deploymentUid) || !uuid(result.agentUid) || !uuid(result.versionUid) || !digest(result.inputSnapshotDigest) || !digest(result.manifestDigest) || !digest(result.artifactDigest) || !digest(result.runtimeBundleDigest) || result.status !== "running") throw new PublisherApiError("invalid_response");
      return { runId: result.runId, deploymentUid: result.deploymentUid, inputSnapshotDigest: result.inputSnapshotDigest };
    },
    async completeLocalRun(input: ApiRecord) {
      const result = await post("/api/v1/local-runtime/runs/result", {
        ...input,
        schemaVersion: "agentscan.local-run-result/1",
      });
      const receipt = localReceipt(result.resultReceipt);
      if (!uuid(result.runId) || result.status !== "completed" || receipt === null) throw new PublisherApiError("invalid_response");
      return { runId: result.runId, receipt };
    },
    async acknowledgeVercelDeployment(input: ApiRecord) {
      const result = await post("/api/v1/vercel-runtime/deployments/ack", input);
      if (!uuid(result.deploymentUid) || !string(result.endpoint) || !string(result.healthEndpoint) || !digest(result.runtimeBundleDigest) || (result.status !== "ready" && result.status !== "active")) throw new PublisherApiError("invalid_response");
      return { deploymentUid: result.deploymentUid, endpoint: result.endpoint, healthEndpoint: result.healthEndpoint, runtimeBundleDigest: result.runtimeBundleDigest, status: result.status };
    },
  };
}
