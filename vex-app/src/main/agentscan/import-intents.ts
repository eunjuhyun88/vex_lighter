/**
 * Main-process owner for AgentScan import intents.
 *
 * This registry is intentionally ephemeral.  An intent is a short-lived
 * request to review a metadata binding; it is not a durable authority record.
 * Locking or restarting Vex drops the registry and the session signing key.
 */

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { stableStringify } from "./stable-json.js";

import type {
  AgentScanImportEvent,
  AgentScanImportReview,
  AgentScanManifest,
  AgentScanSignedReceipt,
} from "@shared/schemas/agentscan-import.js";
import { agentScanManifestSchema } from "@shared/schemas/agentscan-import.js";

export const AGENTSCAN_IMPORT_TTL_MS = 5 * 60 * 1_000;
export const AGENTSCAN_MAX_PENDING_IMPORTS = 64;
export const AGENTSCAN_MAX_TOTAL_IMPORTS = 128;

export interface ImportIntentCreateInput {
  readonly idempotencyKey: string;
  readonly manifestDigest: string;
  readonly manifest: AgentScanManifest;
  readonly sourceOrigin: string;
}

export interface ImportIntentCreated {
  readonly schema: "agentscan.vex.import-intent/1";
  readonly intentId: string;
  readonly state: "awaiting_review";
  readonly expiresAt: string;
}

export interface ImportIntentStatus {
  readonly schema: "agentscan.vex.import-status/1";
  readonly intentId: string;
  readonly state: "awaiting_review" | "approved" | "rejected" | "expired";
  readonly expiresAt: string;
  readonly receipt?: AgentScanSignedReceipt;
}

export interface ImportIntentPreview {
  readonly previewToken: string;
  readonly intentId: string;
  readonly projectId: string;
  readonly scopeVersion: number;
  readonly manifestDigest: string;
  readonly action: "create" | "no_change" | "update_origin";
  readonly relativePath: string;
  /** Exact bytes observed while building the preview; null means absent. */
  readonly fileHash: string | null;
  readonly previousSourceOrigin: string | null;
}

export interface ImportIntentRecord {
  readonly intentId: string;
  readonly sourceOrigin: string;
  readonly manifestDigest: string;
  readonly manifest: AgentScanManifest;
  readonly expiresAtMs: number;
  state: "awaiting_review" | "approved" | "rejected" | "expired";
  terminalUntilMs: number | null;
  receipt: AgentScanSignedReceipt | null;
  preview: ImportIntentPreview | null;
  confirmInFlight: Promise<AgentScanSignedReceipt | "preview_stale"> | null;
}

/** Compare the exact file state captured by preview with a later read. */
export function importPreviewFileStateMatches(
  preview: Pick<ImportIntentPreview, "fileHash">,
  currentHash: string | null,
): boolean {
  return preview.fileHash === currentHash;
}

export type ImportIntentCreateResult =
  | { readonly ok: true; readonly data: ImportIntentCreated; readonly replay: boolean }
  | { readonly ok: false; readonly reason: "session_required" | "pending_bound" | "idempotency_collision" | "invalid_request" };

export type ImportIntentStatusResult =
  | { readonly ok: true; readonly data: ImportIntentStatus }
  | { readonly ok: false; readonly reason: "not_found" };

export type ImportIntentConfirmResult =
  | { readonly outcome: "approved" | "already_approved"; readonly receipt: AgentScanSignedReceipt }
  | { readonly outcome: "expired" | "rejected" | "preview_stale" };

interface RegistryOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxPending?: number;
  readonly maxTotal?: number;
  readonly onIntent?: (event: AgentScanImportEvent) => void;
}

function hexDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function canonicalAgentScanManifest(manifest: AgentScanManifest): string {
  return stableStringify(manifest);
}

export function digestAgentScanManifest(manifest: AgentScanManifest): string {
  return `sha256:${createHash("sha256").update(canonicalAgentScanManifest(manifest), "utf8").digest("hex")}`;
}

export function opaqueProjectRef(projectId: string): string {
  return `sha256:${createHash("sha256").update(`project:${projectId}`, "utf8").digest("hex")}`;
}

function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sameManifest(a: AgentScanManifest, b: AgentScanManifest): boolean {
  return canonicalAgentScanManifest(a) === canonicalAgentScanManifest(b);
}

function isCanonicalOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
  } catch {
    return false;
  }
}

/** A small, deterministic JSON serializer for signatures and file contents. */
export function canonicalBindingFile(input: {
  readonly manifestDigest: string;
  readonly manifest: AgentScanManifest;
  readonly sourceOrigin: string;
}): string {
  return `${stableStringify({
    schema: "agentscan.vex.agent-binding/1",
    manifestDigest: input.manifestDigest,
    manifest: input.manifest,
    sourceOrigin: input.sourceOrigin,
  })}\n`;
}

/** Parse only the exact canonical binding format Vex itself writes. */
export function parseCanonicalBindingFile(text: string): {
  readonly manifestDigest: string;
  readonly manifest: AgentScanManifest;
  readonly sourceOrigin: string;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4
    || candidate.schema !== "agentscan.vex.agent-binding/1"
    || typeof candidate.manifestDigest !== "string"
    || typeof candidate.sourceOrigin !== "string"
    || !isCanonicalOrigin(candidate.sourceOrigin)
  ) return null;
  const parsedManifest = agentScanManifestSchema.safeParse(candidate.manifest);
  if (!parsedManifest.success) return null;
  const binding = {
    manifestDigest: candidate.manifestDigest,
    manifest: parsedManifest.data,
    sourceOrigin: candidate.sourceOrigin,
  };
  return canonicalBindingFile(binding) === text ? binding : null;
}

export type ImportBindingPlan = {
  readonly action: "no_change" | "update_origin";
  readonly previousSourceOrigin: string | null;
};

/** Classify an existing file without permitting arbitrary content to migrate. */
export function classifyExistingBindingForImport(input: {
  readonly text: string;
  readonly manifestDigest: string;
  readonly manifest: AgentScanManifest;
  readonly sourceOrigin: string;
}): ImportBindingPlan | null {
  const existing = parseCanonicalBindingFile(input.text);
  if (
    existing === null
    || existing.manifestDigest !== input.manifestDigest
    || canonicalAgentScanManifest(existing.manifest) !== canonicalAgentScanManifest(input.manifest)
  ) return null;
  return existing.sourceOrigin === input.sourceOrigin
    ? { action: "no_change", previousSourceOrigin: null }
    : { action: "update_origin", previousSourceOrigin: existing.sourceOrigin };
}

export class AgentscanImportIntentRegistry {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #maxTotal: number;
  readonly #onIntent: ((event: AgentScanImportEvent) => void) | undefined;
  readonly #intents = new Map<string, ImportIntentRecord>();
  readonly #idempotency = new Map<string, string>();
  #privateKey: KeyObject;
  #publicKey: KeyObject;

  constructor(options: RegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? AGENTSCAN_IMPORT_TTL_MS;
    this.#maxPending = options.maxPending ?? AGENTSCAN_MAX_PENDING_IMPORTS;
    this.#maxTotal = options.maxTotal ?? AGENTSCAN_MAX_TOTAL_IMPORTS;
    this.#onIntent = options.onIntent;
    const keys = generateKeyPairSync("ed25519");
    this.#privateKey = keys.privateKey;
    this.#publicKey = keys.publicKey;
  }

  /** Lock/restart boundary: no intent or idempotency key survives it. */
  clear(): void {
    this.#intents.clear();
    this.#idempotency.clear();
    const keys = generateKeyPairSync("ed25519");
    this.#privateKey = keys.privateKey;
    this.#publicKey = keys.publicKey;
  }

  /** Remove terminal/expired entries before enforcing bounds. */
  prune(): void {
    const now = this.#now();
    for (const [id, intent] of this.#intents) {
      if (intent.state === "awaiting_review" && intent.expiresAtMs <= now) {
        intent.state = "expired";
        intent.terminalUntilMs = intent.expiresAtMs + this.#ttlMs;
        this.#emit(intent);
      }
      if (intent.state !== "awaiting_review" && intent.confirmInFlight === null && (intent.terminalUntilMs ?? intent.expiresAtMs) <= now) {
        this.#intents.delete(id);
        for (const [key, mappedId] of this.#idempotency) {
          if (mappedId === id) this.#idempotency.delete(key);
        }
      }
    }
  }

  get pendingCount(): number {
    this.prune();
    return [...this.#intents.values()].filter((intent) => intent.state === "awaiting_review").length;
  }

  create(input: ImportIntentCreateInput): ImportIntentCreateResult {
    this.prune();
    const idemKey = `${input.sourceOrigin}\n${input.idempotencyKey}`;
    const existingId = this.#idempotency.get(idemKey);
    if (existingId !== undefined) {
      const existing = this.#intents.get(existingId);
      if (existing !== undefined && existing.manifestDigest === input.manifestDigest && sameManifest(existing.manifest, input.manifest)) {
        if (existing.expiresAtMs > this.#now() || (existing.terminalUntilMs ?? 0) > this.#now()) {
          return { ok: true, replay: true, data: this.#created(existing) };
        }
        return { ok: false, reason: "idempotency_collision" };
      }
      return { ok: false, reason: "idempotency_collision" };
    }
    if (!hexDigest(input.manifestDigest) || digestAgentScanManifest(input.manifest) !== input.manifestDigest) {
      return { ok: false, reason: "invalid_request" };
    }
    if (this.pendingCount >= this.#maxPending || this.#intents.size >= this.#maxTotal) {
      return { ok: false, reason: "pending_bound" };
    }
    const intent: ImportIntentRecord = {
      intentId: newOpaqueId("asi"),
      sourceOrigin: input.sourceOrigin,
      manifestDigest: input.manifestDigest,
      manifest: input.manifest,
      expiresAtMs: this.#now() + this.#ttlMs,
      state: "awaiting_review",
      terminalUntilMs: null,
      receipt: null,
      preview: null,
      confirmInFlight: null,
    };
    this.#intents.set(intent.intentId, intent);
    this.#idempotency.set(idemKey, intent.intentId);
    this.#emit(intent);
    return { ok: true, replay: false, data: this.#created(intent) };
  }

  get(intentId: string): ImportIntentRecord | null {
    this.prune();
    return this.#intents.get(intentId) ?? null;
  }

  getPending(): AgentScanImportReview | null {
    this.prune();
    const pending = [...this.#intents.values()].find((intent) => intent.state === "awaiting_review");
    if (pending === undefined) return null;
    return {
      schema: "agentscan.vex.import-review/1",
      intentId: pending.intentId,
      state: "awaiting_review",
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
      sourceOrigin: pending.sourceOrigin,
      manifestDigest: pending.manifestDigest,
      manifest: pending.manifest,
    };
  }

  status(intentId: string): ImportIntentStatusResult {
    const intent = this.get(intentId);
    if (intent === null) return { ok: false, reason: "not_found" };
    const data: ImportIntentStatus = {
      schema: "agentscan.vex.import-status/1",
      intentId: intent.intentId,
      state: intent.state,
      expiresAt: new Date(intent.expiresAtMs).toISOString(),
      ...(intent.state === "approved" && intent.receipt !== null ? { receipt: intent.receipt } : {}),
    };
    return { ok: true, data };
  }

  reject(intentId: string): "rejected" | "expired" | "already_terminal" {
    const intent = this.get(intentId);
    if (intent === null || intent.state === "expired") return "expired";
    if (intent.state !== "awaiting_review" || intent.confirmInFlight !== null) return "already_terminal";
    intent.state = "rejected";
    intent.terminalUntilMs = intent.expiresAtMs + this.#ttlMs;
    this.#emit(intent);
    return "rejected";
  }

  /**
   * Complete a confirmation exactly once. The callback performs the local
   * confined write; concurrent confirmations share its promise.
   */
  async confirm(
    intentId: string,
    previewToken: string,
    projectId: string,
    expectedScopeVersion: number,
    verify: (intent: ImportIntentRecord, preview: ImportIntentPreview) => Promise<AgentScanSignedReceipt | "preview_stale">,
  ): Promise<ImportIntentConfirmResult> {
    const intent = this.get(intentId);
    if (intent === null || intent.state === "expired") return { outcome: "expired" };
    if (intent.state === "rejected") return { outcome: "rejected" };
    if (intent.state === "approved" && intent.receipt !== null) return { outcome: "already_approved", receipt: intent.receipt };
    const preview = intent.preview;
    if (preview === null || preview.previewToken !== previewToken || preview.projectId !== projectId || preview.scopeVersion !== expectedScopeVersion || preview.manifestDigest !== intent.manifestDigest) {
      return { outcome: "preview_stale" };
    }
    if (intent.confirmInFlight !== null) {
      const receipt = await intent.confirmInFlight;
      return receipt === "preview_stale"
        ? { outcome: "preview_stale" }
        : { outcome: "already_approved", receipt };
    }
    const run = verify(intent, preview);
    intent.confirmInFlight = run;
    try {
      const receipt = await run;
      if (receipt === "preview_stale") return { outcome: "preview_stale" };
      intent.receipt = receipt;
      intent.state = "approved";
      intent.terminalUntilMs = intent.expiresAtMs + this.#ttlMs;
      this.#emit(intent);
      return { outcome: "approved", receipt };
    } finally {
      intent.confirmInFlight = null;
    }
  }

  setPreview(intentId: string, preview: Omit<ImportIntentPreview, "previewToken">): ImportIntentPreview | null {
    const intent = this.get(intentId);
    if (intent === null || intent.state !== "awaiting_review") return null;
    const next: ImportIntentPreview = { ...preview, previewToken: newOpaqueId("asp") };
    intent.preview = next;
    return next;
  }

  signReceipt(payload: Omit<AgentScanSignedReceipt["payload"], "schema" | "receiptId" | "issuedAt" | "bindingRef" | "cloudInstall">, cloudInstall?: AgentScanSignedReceipt["payload"]["cloudInstall"]): AgentScanSignedReceipt {
    const receiptId = newOpaqueId("asr");
    const issuedAt = new Date(this.#now()).toISOString();
    const bindingRef = `sha256:${createHash("sha256").update(`${payload.intentId}\n${payload.manifestDigest}\n${payload.projectRef}\n${payload.projectRevision}`, "utf8").digest("hex")}`;
    const completePayload = { schema: "agentscan.vex.binding-receipt/1" as const, ...payload, receiptId, issuedAt, bindingRef, ...(cloudInstall ? { cloudInstall } : {}) };
    const signature = signBytes(null, Buffer.from(stableStringify(completePayload), "utf8"), this.#privateKey).toString("base64url");
    const publicKey = this.#publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const keyId = `sha256:${createHash("sha256").update(publicKey, "utf8").digest("hex")}`;
    return {
      schema: "agentscan.vex.signed-binding/1",
      payload: completePayload,
      signature: { alg: "Ed25519", keyId, publicKey, signature },
    };
  }

  #created(intent: ImportIntentRecord): ImportIntentCreated {
    return {
      schema: "agentscan.vex.import-intent/1",
      intentId: intent.intentId,
      state: "awaiting_review",
      expiresAt: new Date(intent.expiresAtMs).toISOString(),
    };
  }

  #emit(intent: ImportIntentRecord): void {
    if (intent.state !== "awaiting_review") return;
    this.#onIntent?.({
      intentId: intent.intentId,
      state: "awaiting_review",
      expiresAt: new Date(intent.expiresAtMs).toISOString(),
    });
  }
}
