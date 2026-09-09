import { createHash, randomBytes } from "node:crypto";
import { stableStringify } from "./stable-json.js";
import {
  publicationRequestSchema,
  type PublicationFailureCode,
  type PublicationIntentEvent,
  type PublicationIntentReview,
  type PublicationRequest,
  type PublicationReceipt,
  type PublicationStatus,
} from "@shared/schemas/agentscan-publication.js";

export const AGENTSCAN_PUBLICATION_TTL_MS = 5 * 60 * 1_000;
/** Local profile review includes a human-authored form, so allow a realistic
 * editing window while retaining a hard expiry for abandoned intents. */
export const AGENTSCAN_LOCAL_PUBLICATION_TTL_MS = 30 * 60 * 1_000;
export const AGENTSCAN_MAX_PENDING_PUBLICATIONS = 16;

export type PublicationRecord = {
  readonly intentId: string;
  readonly sourceOrigin: string;
  request: PublicationRequest | null;
  readonly mode: "browser_request" | "local_project";
  readonly idempotencyKey: string;
  expiresAtMs: number;
  state: "awaiting_review" | "approved" | "rejected" | "expired" | "failed";
  preview: PublicationPreviewRecord | null;
  result: { intentId: string; status: "completed"; listing: Record<string, unknown>; receipt: PublicationReceipt } | undefined;
  error: PublicationFailureCode | null;
  inFlight: Promise<PublicationConfirmResult> | null;
};
export type PublicationPreviewRecord = {
  readonly previewToken: string;
  readonly projectId: string;
  readonly scopeVersion: number;
  readonly relativePath: string;
  readonly fileHash: string | null;
  readonly action: "create" | "no_change";
  readonly profileFileHash?: string | null;
  readonly profileText?: string;
  readonly profileAction?: "create" | "no_change";
  readonly profileRevisionDigest?: string;
  /** Main-process-only binding state for a local project update. */
  readonly identityFileHash?: string | null;
  readonly localIdentity?: { readonly agentUid: string; readonly latestVersionUid: string; readonly semver: string; readonly publisherKeyId: string } | null;
};
export type PublicationConfirmResult =
  | { outcome: "approved"; publication: { intentId: string; status: "completed"; listing: Record<string, unknown>; receipt: PublicationReceipt } }
  | { outcome: "preview_stale" }
  | { outcome: "failed"; failure: { code: PublicationFailureCode } };

type Options = {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly onIntent?: (event: PublicationIntentEvent) => void;
};

type PublicationCreateData =
  | { schema: "agentscan.vex.publication-intent/1"; intentId: string; state: "awaiting_review"; expiresAt: string }
  | PublicationStatus;

export function publicationManifestDigest(request: PublicationRequest): string {
  return `sha256:${createHash("sha256").update(stableStringify(request.version.manifest), "utf8").digest("hex")}`;
}
function newId(prefix: string): string { return `${prefix}_${randomBytes(16).toString("hex")}`; }

export class PublicationIntentRegistry {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #onIntent: ((event: PublicationIntentEvent) => void) | undefined;
  readonly #records = new Map<string, PublicationRecord>();
  readonly #idempotency = new Map<string, string>();
  constructor(options: Options = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? AGENTSCAN_PUBLICATION_TTL_MS;
    this.#onIntent = options.onIntent;
  }
  clear(): void { this.#records.clear(); this.#idempotency.clear(); }
  prune(): void {
    const now = this.#now();
    for (const [id, record] of this.#records) {
      if (record.state === "awaiting_review" && record.expiresAtMs <= now) {
        record.state = "expired"; this.#emit(record);
      }
    }
  }
  create(sourceOrigin: string, request: PublicationRequest): { ok: true; data: PublicationCreateData; replay: boolean } | { ok: false; reason: "idempotency_collision" | "pending_bound" | "invalid_request" } {
    this.prune();
    const artifactDigest = publicationManifestDigest(request);
    if (artifactDigest !== request.version.manifestDigest || artifactDigest !== request.version.artifactDigest) return { ok: false, reason: "invalid_request" };
    const idem = `${sourceOrigin}\n${request.idempotencyKey}`;
    const priorId = this.#idempotency.get(idem);
    if (priorId !== undefined) {
      const prior = this.#records.get(priorId);
      if (prior !== undefined && prior.state === "failed" && stableStringify(prior.request) === stableStringify(request)) {
        prior.state = "awaiting_review";
        prior.expiresAtMs = this.#now() + this.#ttlMs;
        prior.preview = null;
        prior.error = null;
        this.#emit(prior);
        return { ok: true, replay: true, data: this.#created(prior) };
      }
      if (prior !== undefined && stableStringify(prior.request) === stableStringify(request)) {
        return { ok: true, replay: true, data: prior.state === "awaiting_review" ? this.#created(prior) : this.#status(prior) };
      }
      return { ok: false, reason: "idempotency_collision" };
    }
    if ([...this.#records.values()].filter((item) => item.state === "awaiting_review").length >= AGENTSCAN_MAX_PENDING_PUBLICATIONS) return { ok: false, reason: "pending_bound" };
    const record: PublicationRecord = {
      intentId: newId("aspub"), sourceOrigin, request, mode: "browser_request", idempotencyKey: request.idempotencyKey,
      expiresAtMs: this.#now() + this.#ttlMs,
      state: "awaiting_review", preview: null, result: undefined, error: null, inFlight: null,
    };
    this.#records.set(record.intentId, record); this.#idempotency.set(idem, record.intentId); this.#emit(record);
    return { ok: true, replay: false, data: this.#created(record) };
  }
  /**
   * Create an intent without accepting a manifest from the browser. The
   * selected project and its VEX-owned public profile are resolved later by
   * the main-process preview handler.
   */
  createLocal(sourceOrigin: string, idempotencyKey: string): { ok: true; data: PublicationCreateData; replay: boolean } | { ok: false; reason: "idempotency_collision" | "pending_bound" } {
    this.prune();
    const idem = `${sourceOrigin}\n${idempotencyKey}`;
    const priorId = this.#idempotency.get(idem);
    if (priorId !== undefined) {
      const prior = this.#records.get(priorId);
      // The browser's local launch carries only an idempotency key. Once VEX
      // has bound the selected project's profile, the same launch must still
      // replay its opaque intent rather than becoming a collision.
      if (prior?.mode === "local_project") return { ok: true, replay: true, data: prior.state === "awaiting_review" ? this.#created(prior) : this.#status(prior) };
      return { ok: false, reason: "idempotency_collision" };
    }
    if ([...this.#records.values()].filter((item) => item.state === "awaiting_review").length >= AGENTSCAN_MAX_PENDING_PUBLICATIONS) return { ok: false, reason: "pending_bound" };
    const record: PublicationRecord = {
      intentId: newId("aspub"), sourceOrigin, request: null, mode: "local_project", idempotencyKey,
      expiresAtMs: this.#now() + AGENTSCAN_LOCAL_PUBLICATION_TTL_MS,
      state: "awaiting_review", preview: null, result: undefined, error: null, inFlight: null,
    };
    this.#records.set(record.intentId, record); this.#idempotency.set(idem, record.intentId); this.#emit(record);
    return { ok: true, replay: false, data: this.#created(record) };
  }
  /** Bind the main-owned request once a local profile has been previewed. */
  setLocalRequest(intentId: string, request: PublicationRequest): PublicationRecord | null {
    const record = this.get(intentId);
    if (!record || record.mode !== "local_project" || record.state !== "awaiting_review") return null;
    if (request.idempotencyKey !== record.idempotencyKey || validatePublicationRequest(request) === null) return null;
    const digest = publicationManifestDigest(request);
    if (digest !== request.version.manifestDigest || digest !== request.version.artifactDigest) return null;
    record.request = request;
    return record;
  }
  get(intentId: string): PublicationRecord | null { this.prune(); return this.#records.get(intentId) ?? null; }
  getPending(): PublicationIntentReview | null {
    this.prune(); const record = [...this.#records.values()].find((item) => item.state === "awaiting_review");
    if (!record) return null;
    return { schema: "agentscan.vex.publication-review/1", intentId: record.intentId, state: "awaiting_review", expiresAt: new Date(record.expiresAtMs).toISOString(), sourceOrigin: record.sourceOrigin, mode: record.mode, request: record.request };
  }
  setPreview(intentId: string, preview: Omit<PublicationPreviewRecord, "previewToken">): PublicationPreviewRecord | null {
    const record = this.get(intentId); if (!record || record.state !== "awaiting_review") return null;
    record.preview = { ...preview, previewToken: newId("aspv") }; return record.preview;
  }
  status(intentId: string): PublicationStatus | null {
    const record = this.get(intentId); if (!record) return null;
    return this.#status(record);
  }
  reject(intentId: string): "rejected" | "expired" | "already_terminal" {
    const record = this.get(intentId); if (!record || record.state === "expired") return "expired";
    if (record.state !== "awaiting_review" || record.inFlight) return "already_terminal";
    record.state = "rejected"; this.#emit(record); return "rejected";
  }
  async confirm(intentId: string, previewToken: string, projectId: string, expectedScopeVersion: number, verify: (record: PublicationRecord, preview: PublicationPreviewRecord) => Promise<PublicationConfirmResult>): Promise<{ outcome: "approved" | "already_approved"; publication: { intentId: string; status: "completed"; listing: Record<string, unknown>; receipt: PublicationReceipt } } | { outcome: "expired" | "rejected" | "preview_stale" } | { outcome: "failed"; failure: { code: PublicationFailureCode } }> {
    const record = this.get(intentId);
    if (!record || record.state === "expired") return { outcome: "expired" };
    if (record.state === "rejected") return { outcome: "rejected" };
    if (record.state === "failed") return { outcome: "failed", failure: { code: record.error ?? "internal" } };
    if (record.state === "approved" && record.result) return { outcome: "already_approved", publication: record.result };
    const preview = record.preview;
    if (!preview || preview.previewToken !== previewToken || preview.projectId !== projectId || preview.scopeVersion !== expectedScopeVersion) return { outcome: "preview_stale" };
    if (record.inFlight) { const outcome = await record.inFlight; if (outcome.outcome !== "approved") return outcome; return { outcome: "already_approved", publication: outcome.publication }; }
    record.inFlight = verify(record, preview);
    try {
      const outcome = await record.inFlight;
      if (outcome.outcome === "preview_stale") return outcome;
      if (outcome.outcome !== "approved") { record.state = "failed"; record.error = outcome.failure.code; this.#emit(record); return outcome; }
      record.result = outcome.publication; record.state = "approved"; this.#emit(record); return { outcome: "approved", publication: outcome.publication };
    } finally { record.inFlight = null; }
  }
  #created(record: PublicationRecord) { return { schema: "agentscan.vex.publication-intent/1" as const, intentId: record.intentId, state: "awaiting_review" as const, expiresAt: new Date(record.expiresAtMs).toISOString() }; }
  #status(record: PublicationRecord): PublicationStatus { return { schema: "agentscan.vex.publication-status/1", intentId: record.intentId, state: record.state, expiresAt: new Date(record.expiresAtMs).toISOString(), ...(record.result ? { receipt: record.result.receipt, listing: record.result.listing } : {}), ...(record.error ? { error: record.error } : {}) }; }
  #emit(record: PublicationRecord): void { if (record.state === "awaiting_review") this.#onIntent?.({ intentId: record.intentId, state: "awaiting_review", expiresAt: new Date(record.expiresAtMs).toISOString() }); }
}

export function validatePublicationRequest(value: unknown): PublicationRequest | null {
  const parsed = publicationRequestSchema.safeParse(value); return parsed.success ? parsed.data : null;
}
