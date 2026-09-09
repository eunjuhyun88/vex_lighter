import { z } from "zod";
import { app, BrowserWindow } from "electron";
import { CH, EV } from "@shared/ipc/channels.js";
import { err, ok } from "@shared/ipc/result.js";
import {
  publicationConfirmResultSchema,
  publicationConfirmInputSchema,
  publicationIntentReviewSchema,
  publicationIntentEventSchema,
  publicationPreviewInputSchema,
  publicationPreviewSchema,
  publicationRejectInputSchema,
  publicationRejectResultSchema,
  type PublicationPreview,
  type PublicationFailureCode,
  type LocalAgentPublicProfileDraft,
} from "@shared/schemas/agentscan-publication.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { readProjectRenderScope } from "../database/projects/render-scope.js";
import type { ProjectRenderScope } from "../database/projects/render-scope.js";
import { resolveProjectsRoot, resolveProjectDirectory } from "../studio/projects-root.js";
import { realProjectDirectory } from "../studio/files/node-path.js";
import { readConfinedFile, replaceConfinedFile } from "../studio/installer/confined-fs.js";
import { resolveArtifactPath } from "../studio/installer/paths.js";
import { stableStringify } from "../agentscan/stable-json.js";
import { PublicationIntentRegistry, type PublicationRecord, type PublicationPreviewRecord } from "../agentscan/publication-intents.js";
import { PublisherApiError } from "../agentscan/publisher-client.js";
import {
  LOCAL_AGENT_PUBLIC_PROFILE_PATH,
  LOCAL_AGENT_IDENTITY_PATH,
  canonicalLocalAgentIdentity,
  localProfileSlug,
  localProfileDigest,
  localProfileToManifest,
  parseLocalAgentIdentity,
  parseLocalAgentPublicProfile,
} from "../agentscan/local-profile.js";
import { registerHandler } from "./register-handler.js";

const registry = new PublicationIntentRegistry({
  onIntent: (event) => {
    broadcastToAllWindows(EV.studio.agentscanPublicationIntent, event);
    try {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (window) { app.focus({ steal: true }); if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
    } catch { /* quit race; getPending repairs the notification */ }
  },
});
export function getAgentscanPublicationIntentRegistry(): PublicationIntentRegistry { return registry; }
const empty = z.object({}).strict();
type PublicationFailureReason = "intent_expired" | "public_profile_missing";
function failure(
  correlationId: string,
  message: string,
  reason?: PublicationFailureReason,
) {
  return err({
    code: "validation.invalid_input" as const,
    domain: "studio" as const,
    message,
    retryable: false,
    userActionable: true,
    redacted: true,
    ...(reason === undefined ? {} : { details: { reason } }),
    correlationId,
  });
}
function publicationPath(digest: string): string { return `.vex/agentscan/publications/${digest.slice("sha256:".length)}.json`; }
function publicationFile(record: PublicationRecord): string {
  if (record.request === null) throw new Error("publication_request_unbound");
  return `${stableStringify(record.request.version.manifest)}\n`;
}

function failedPublication(error?: unknown): { outcome: "failed"; failure: { code: PublicationFailureCode } } {
  let code: PublicationFailureCode = "internal";
  if (error instanceof PublisherApiError) {
    code = error.code;
  } else if (error instanceof Error) {
    if (error.message === "agentscan_reporting_not_ready") code = "not_ready";
    else if (error.message === "publisher_key_id_mismatch" || error.message === "publisher_key_drift") code = "publisher_key_mismatch";
    else if (error.message === "publication_listing_invalid" || error.message === "publication_parent_mismatch") code = "invalid_response";
  }
  return { outcome: "failed", failure: { code } };
}

async function projectDirectory(projectId: string, correlationId: string): Promise<{ directory: string; scope: ProjectRenderScope } | null> {
  const scope = await readProjectRenderScope(projectId);
  if (!scope.ok || scope.data === null) return null;
  const root = await resolveProjectsRoot(correlationId); if (!root.ok) return null;
  const lexical = resolveProjectDirectory(root.data, scope.data.slug); if (!lexical) return null;
  const directory = await realProjectDirectory(root.data, lexical); if (!directory.ok) return null;
  return { directory: directory.directory, scope: scope.data };
}

function profileFromDraft(draft: LocalAgentPublicProfileDraft) {
  return {
    schema: "agentscan.vex.agent-public/1" as const,
    semver: draft.semver,
    manifest: {
      schemaVersion: "agentscan.strategy-manifest/1" as const,
      name: draft.name,
      summary: draft.summary,
      capabilities: draft.capabilities,
      inputs: draft.inputs,
      outputs: draft.outputs,
      executionEnabled: false as const,
      strategy: {},
    },
  };
}

async function preview(record: PublicationRecord, projectId: string, expectedScopeVersion: number, correlationId: string, profileDraft?: LocalAgentPublicProfileDraft): Promise<ReturnType<typeof ok<PublicationPreview>> | ReturnType<typeof failure>> {
  const resolved = await projectDirectory(projectId, correlationId);
  let identityFileHash: string | null | undefined;
  let localIdentity: { readonly agentUid: string; readonly latestVersionUid: string; readonly semver: string; readonly publisherKeyId: string } | null | undefined;
  let profileFileHash: string | null | undefined;
  let profileText: string | undefined;
  let profileAction: "create" | "no_change" | undefined;
  let profileRevisionDigest: string | undefined;
  if (!resolved || resolved.scope.scopeVersion !== expectedScopeVersion) return failure(correlationId, "The selected project changed; choose it again and preview again.");
  if (record.mode === "local_project") {
    // Local-first launch: the browser submitted no manifest. Read exactly the
    // VEX-owned public profile from the selected project, then bind the
    // validated declaration to this ephemeral intent. No source tree is read.
    const profilePath = await resolveArtifactPath(resolved.directory, LOCAL_AGENT_PUBLIC_PROFILE_PATH);
    if (profilePath.kind === "refused") return failure(correlationId, "The VEX public profile path is not safe to use.");
    const profileFile = profilePath.exists
      ? await readConfinedFile(profilePath.absolutePath, LOCAL_AGENT_PUBLIC_PROFILE_PATH, profilePath.mode)
      : { kind: "absent" as const };
    if (profileFile.kind === "refused") return failure(correlationId, "The VEX public profile could not be read.");
    if (profileFile.kind === "absent" && profileDraft === undefined) {
      return failure(
        correlationId,
        "This project has no VEX public profile. Complete the public profile form and preview again.",
        "public_profile_missing",
      );
    }
    profileFileHash = profileFile.kind === "file" ? profileFile.hash : null;
    const parsedProfile = profileDraft
      ? parseLocalAgentPublicProfile(`${stableStringify(profileFromDraft(profileDraft))}\n`)
      : profileFile.kind === "file" ? parseLocalAgentPublicProfile(profileFile.text) : { ok: false as const, reason: "invalid_json" as const };
    if (!parsedProfile.ok) return failure(correlationId, "The VEX public profile is invalid or not canonical.");
    profileText = `${stableStringify(parsedProfile.profile)}\n`;
    profileAction = profileFile.kind === "file" && profileText === profileFile.text ? "no_change" : "create";
    const identityPath = await resolveArtifactPath(resolved.directory, LOCAL_AGENT_IDENTITY_PATH);
    if (identityPath.kind === "refused") return failure(correlationId, "The VEX AgentScan identity path is not safe to use.");
    const identityFile = identityPath.exists
      ? await readConfinedFile(identityPath.absolutePath, LOCAL_AGENT_IDENTITY_PATH, identityPath.mode)
      : { kind: "absent" as const };
    if (identityFile.kind === "refused") return failure(correlationId, "The VEX AgentScan identity could not be read.");
    if (identityFile.kind === "file") {
      const parsedIdentity = parseLocalAgentIdentity(identityFile.text);
      if (!parsedIdentity.ok) return failure(correlationId, "The VEX AgentScan identity is invalid or not canonical; recover it before updating.");
      identityFileHash = identityFile.hash;
      localIdentity = parsedIdentity.identity;
    } else {
      identityFileHash = null;
      localIdentity = null;
    }
    const built = localProfileToManifest(parsedProfile.profile);
    profileRevisionDigest = localProfileDigest(parsedProfile.profile);
    const request = {
      schema: "agentscan.vex.publication-request/1" as const,
      idempotencyKey: record.idempotencyKey,
      agent: localIdentity
        ? { agentUid: localIdentity.agentUid }
        : { slug: localProfileSlug(built.manifest.name), displayName: built.manifest.name, summary: built.manifest.summary },
      version: {
        semver: parsedProfile.profile.semver,
        manifest: built.manifest,
        manifestDigest: built.manifestDigest,
        artifactDigest: built.artifactDigest,
      },
      ...(localIdentity ? { parentVersionUid: localIdentity.latestVersionUid } : {}),
    };
    const bound = registry.setLocalRequest(record.intentId, request);
    if (bound === null || bound.request === null) {
      return failure(
        correlationId,
        "The local publication intent is no longer pending.",
        "intent_expired",
      );
    }
  }
  if (record.request === null) {
    // A profile draft is only useful for a local launch. Existing browser
    // requests retain their original manifest and never write a profile.
    return failure(correlationId, "The local public profile is not available.");
  }
  const request = record.request;
  // A bound local intent can be previewed again after the renderer refreshes;
  // capture the binding hash on every such preview, not only on first bind.
  if (record.mode === "local_project" && identityFileHash === undefined) {
    const identityPath = await resolveArtifactPath(resolved.directory, LOCAL_AGENT_IDENTITY_PATH);
    if (identityPath.kind === "refused") return failure(correlationId, "The VEX AgentScan identity path is not safe to use.");
    const identityFile = identityPath.exists
      ? await readConfinedFile(identityPath.absolutePath, LOCAL_AGENT_IDENTITY_PATH, identityPath.mode)
      : { kind: "absent" as const };
    if (identityFile.kind === "refused") return failure(correlationId, "The VEX AgentScan identity could not be read.");
    identityFileHash = identityFile.kind === "file" ? identityFile.hash : null;
    if (identityFile.kind === "file") {
      const parsedIdentity = parseLocalAgentIdentity(identityFile.text);
      if (!parsedIdentity.ok) return failure(correlationId, "The VEX AgentScan identity is invalid or not canonical; recover it before updating.");
      localIdentity = parsedIdentity.identity;
    } else localIdentity = null;
    const boundAgentUid = request.agent.agentUid;
    const boundParentVersionUid = request.parentVersionUid;
    if (localIdentity
      ? boundAgentUid !== localIdentity.agentUid || boundParentVersionUid !== localIdentity.latestVersionUid
      : boundAgentUid !== undefined || boundParentVersionUid !== undefined) {
      return failure(correlationId, "The local AgentScan identity changed; preview again from the current binding or choose fork/recovery.");
    }
  }
  const relativePath = publicationPath(request.version.manifestDigest);
  const target = await resolveArtifactPath(resolved.directory, relativePath);
  if (target.kind === "refused") return failure(correlationId, "The publication path is not safe to use.");
  const current = target.exists ? await readConfinedFile(target.absolutePath, relativePath, target.mode) : { kind: "absent" as const };
  if (current.kind === "refused") return failure(correlationId, "The existing publication file could not be read.");
  const expected = publicationFile(record);
  let action: "create" | "no_change" = "create";
  if (current.kind === "file") {
    if (current.text !== expected) return failure(correlationId, "An existing publication differs; review it before publishing.");
    action = "no_change";
  }
  const saved = registry.setPreview(record.intentId, { projectId, scopeVersion: resolved.scope.scopeVersion, relativePath, fileHash: current.kind === "file" ? current.hash : null, action, ...(record.mode === "local_project" ? { identityFileHash, localIdentity, profileFileHash, profileText, profileAction, profileRevisionDigest } : {}) });
  if (!saved) {
    return failure(
      correlationId,
      "Publication intent is no longer pending.",
      "intent_expired",
    );
  }
  const output: PublicationPreview = {
    schema: "agentscan.vex.publication-preview/1", intentId: record.intentId, previewToken: saved.previewToken,
    manifestDigest: request.version.manifestDigest, artifactDigest: request.version.artifactDigest,
    manifestJson: expected, ...(profileText ? { profileJson: profileText } : {}), relativePath, project: { id: resolved.scope.projectId, name: resolved.scope.name, scopeVersion: resolved.scope.scopeVersion }, action,
  };
  return ok(output);
}

async function confirm(record: PublicationRecord, previewRecord: PublicationPreviewRecord, correlationId: string) {
  const request = record.request;
  if (request === null) return failedPublication();
  const resolved = await projectDirectory(previewRecord.projectId, correlationId);
  if (!resolved || resolved.scope.scopeVersion !== previewRecord.scopeVersion) return { outcome: "preview_stale" as const };
  const target = await resolveArtifactPath(resolved.directory, previewRecord.relativePath);
  if (target.kind === "refused") return { outcome: "preview_stale" as const };
  const current = target.exists ? await readConfinedFile(target.absolutePath, previewRecord.relativePath, target.mode) : { kind: "absent" as const };
  if (current.kind === "refused" || (current.kind === "file" ? current.hash : null) !== previewRecord.fileHash) return { outcome: "preview_stale" as const };
  if (record.mode === "local_project") {
    const identityPath = await resolveArtifactPath(resolved.directory, LOCAL_AGENT_IDENTITY_PATH);
    if (identityPath.kind === "refused") return { outcome: "preview_stale" as const };
    const identityFile = identityPath.exists
      ? await readConfinedFile(identityPath.absolutePath, LOCAL_AGENT_IDENTITY_PATH, identityPath.mode)
      : { kind: "absent" as const };
    if (identityFile.kind === "refused" || (identityFile.kind === "file" ? identityFile.hash : null) !== (previewRecord.identityFileHash ?? null)) return { outcome: "preview_stale" as const };
    if (identityFile.kind === "file" && !parseLocalAgentIdentity(identityFile.text).ok) return failedPublication();
    const profilePath = await resolveArtifactPath(resolved.directory, LOCAL_AGENT_PUBLIC_PROFILE_PATH);
    if (profilePath.kind === "refused" || previewRecord.profileText === undefined) return failedPublication();
    const profileFile = profilePath.exists
      ? await readConfinedFile(profilePath.absolutePath, LOCAL_AGENT_PUBLIC_PROFILE_PATH, profilePath.mode)
      : { kind: "absent" as const };
    if (profileFile.kind === "refused" || (profileFile.kind === "file" ? profileFile.hash : null) !== (previewRecord.profileFileHash ?? null)) return { outcome: "preview_stale" as const };
    if (previewRecord.profileAction === "create") {
      const written = await replaceConfinedFile({ projectDirectory: resolved.directory, absolutePath: profilePath.absolutePath, relativeLabel: LOCAL_AGENT_PUBLIC_PROFILE_PATH, text: previewRecord.profileText, expectedHash: profileFile.kind === "file" ? profileFile.hash : null, mode: profilePath.mode });
      if (written.kind === "refused") return failedPublication();
    }
  }
  if (previewRecord.action === "create" || current.kind === "file" && current.text !== publicationFile(record)) {
    const written = await replaceConfinedFile({ projectDirectory: resolved.directory, absolutePath: target.absolutePath, relativeLabel: previewRecord.relativePath, text: publicationFile(record), expectedHash: current.kind === "file" ? current.hash : null, mode: target.mode });
    if (written.kind === "refused") return failedPublication();
  }
  try {
    const { completeManifestOnlyPublication } = await import("../agentscan/publisher-service.js");
    if (record.mode === "local_project" && previewRecord.profileRevisionDigest === undefined) return failedPublication();
    const publication = await completeManifestOnlyPublication(request, previewRecord.localIdentity?.publisherKeyId, record.mode === "local_project" && previewRecord.profileRevisionDigest ? { localIntentId: record.intentId, profileRevisionDigest: previewRecord.profileRevisionDigest } : undefined);
    if (record.mode === "local_project") {
      const identityPath = await resolveArtifactPath(resolved.directory, LOCAL_AGENT_IDENTITY_PATH);
      if (identityPath.kind === "refused") return failedPublication();
      const identityFile = identityPath.exists
        ? await readConfinedFile(identityPath.absolutePath, LOCAL_AGENT_IDENTITY_PATH, identityPath.mode)
        : { kind: "absent" as const };
      if (identityFile.kind === "refused" || (identityFile.kind === "file" ? identityFile.hash : null) !== (previewRecord.identityFileHash ?? null)) return failedPublication();
      const payload = publication.receipt.payload;
      const profileRevisionDigest = previewRecord.profileRevisionDigest;
      if (profileRevisionDigest === undefined || typeof payload.listingUid !== "string") return failedPublication();
      const identity = {
        schema: "agentscan.vex.agent-identity/1" as const,
        agentUid: payload.agentUid,
        latestVersionUid: payload.versionUid,
        semver: request.version.semver,
        publisherKeyId: payload.publisherKeyId,
        listingUid: payload.listingUid,
        profileRevisionDigest,
        manifestDigest: payload.manifestDigest,
      };
      const canonical = canonicalLocalAgentIdentity(identity);
      const written = await replaceConfinedFile({ projectDirectory: resolved.directory, absolutePath: identityPath.absolutePath, relativeLabel: LOCAL_AGENT_IDENTITY_PATH, text: canonical, expectedHash: identityFile.kind === "file" ? identityFile.hash : null, mode: identityPath.mode });
      if (written.kind === "refused") return failedPublication();
    }
    return { outcome: "approved" as const, publication };
  } catch (error) {
    return failedPublication(error);
  }
}

export function registerAgentscanPublicationHandlers(): Array<() => void> {
  return [
    registerHandler({ channel: CH.studio.agentscanPublicationGetPending, domain: "studio", inputSchema: empty, outputSchema: publicationIntentReviewSchema.nullable(), handle: async () => ok(registry.getPending()) }),
    registerHandler({
      channel: CH.studio.agentscanPublicationPreview,
      domain: "studio",
      inputSchema: publicationPreviewInputSchema,
      outputSchema: publicationPreviewSchema,
      handle: (input, ctx) => {
        const record = registry.get(input.intentId);
        return record
          ? preview(record, input.projectId, input.expectedScopeVersion, ctx.requestId, input.profile)
          : Promise.resolve(failure(ctx.requestId, "Publication intent expired.", "intent_expired"));
      },
    }),
    registerHandler({ channel: CH.studio.agentscanPublicationConfirm, domain: "studio", inputSchema: publicationConfirmInputSchema, outputSchema: publicationConfirmResultSchema, handle: async (input, ctx) => ok(await registry.confirm(input.intentId, input.previewToken, input.projectId, input.expectedScopeVersion, (record, previewRecord) => confirm(record, previewRecord, ctx.requestId))) }),
    registerHandler({ channel: CH.studio.agentscanPublicationReject, domain: "studio", inputSchema: publicationRejectInputSchema, outputSchema: publicationRejectResultSchema, handle: async (input) => ok({ outcome: registry.reject(input.intentId) }) }),
  ];
}
