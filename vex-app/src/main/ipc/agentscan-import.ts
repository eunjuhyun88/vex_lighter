/** AgentScan -> Vex Studio metadata-only import intent surface. */

import { z } from "zod";
import { app, BrowserWindow } from "electron";
import { CH, EV } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  agentScanImportConfirmInputSchema,
  agentScanImportConfirmResultSchema,
  agentScanImportGetPendingInputSchema,
  agentScanImportPreviewInputSchema,
  agentScanImportPreviewSchema,
  agentScanImportRejectInputSchema,
  agentScanImportRejectResultSchema,
  agentScanImportReviewSchema,
  type AgentScanImportPreview,
} from "@shared/schemas/agentscan-import.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { readProjectRenderScope } from "../database/projects/render-scope.js";
import { resolveProjectsRoot, resolveProjectDirectory } from "../studio/projects-root.js";
import { readConfinedFile, replaceConfinedFile } from "../studio/installer/confined-fs.js";
import { resolveArtifactPath } from "../studio/installer/paths.js";
import { realProjectDirectory } from "../studio/files/node-path.js";
import {
  AgentscanImportIntentRegistry,
  canonicalBindingFile,
  classifyExistingBindingForImport,
  importPreviewFileStateMatches,
  opaqueProjectRef,
  type ImportIntentRecord,
} from "../agentscan/import-intents.js";
import {
  LOCAL_RUNTIME_BINDING_PATH,
  canonicalLocalRuntimeBinding,
  parseLocalRuntimeBinding,
} from "../agentscan/local-strategy-runtime.js";
import { registerHandler } from "./register-handler.js";

const registry = new AgentscanImportIntentRegistry({
  onIntent: (event) => {
    broadcastToAllWindows(EV.studio.agentscanImportIntent, event);
    // The browser initiated an action that now requires a human decision in
    // Vex. Bring the existing Vex window forward, but never create a window
    // or expose project data as part of this notification.
    try {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (window !== undefined) {
        app.focus({ steal: true });
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    } catch {
      // A quit race is ordinary; the intent remains in the in-memory owner
      // and the next Vex focus can pull it through getPending.
    }
  },
});

export function getAgentscanImportIntentRegistry(): AgentscanImportIntentRegistry {
  return registry;
}

function failure(domain: "studio", correlationId: string, message: string) {
  return err({
    code: "validation.invalid_input" as const,
    domain,
    message,
    retryable: false,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

const empty = z.object({}).strict();

/** Build and validate a local preview without mutating the project. */
async function previewImport(
  intentId: string,
  projectId: string,
  expectedScopeVersion: number,
  correlationId: string,
): Promise<Result<AgentScanImportPreview>> {
  const intent = registry.get(intentId);
  if (intent === null || intent.state === "expired") return failure("studio", correlationId, "Import intent expired.");
  if (intent.state !== "awaiting_review") return failure("studio", correlationId, "Import intent is no longer pending.");

  const scope = await readProjectRenderScope(projectId);
  if (!scope.ok || scope.data === null || scope.data.scopeVersion !== expectedScopeVersion) {
    return failure("studio", correlationId, "The selected project changed; choose it again and preview again.");
  }
  const root = await resolveProjectsRoot(correlationId);
  if (!root.ok) return failure("studio", correlationId, "The Studio projects folder is unavailable.");
  const lexicalDirectory = resolveProjectDirectory(root.data, scope.data.slug);
  if (lexicalDirectory === null) return failure("studio", correlationId, "The selected project could not be resolved.");
  const directory = await realProjectDirectory(root.data, lexicalDirectory);
  if (!directory.ok) return failure("studio", correlationId, "The selected project could not be resolved.");

  const relativePath = `.vex/agentscan/${intent.manifestDigest.slice("sha256:".length)}.json`;
  const resolved = await resolveArtifactPath(directory.directory, relativePath);
  if (resolved.kind === "refused") return failure("studio", correlationId, "The AgentScan binding path is not safe to use.");
  const current = resolved.exists
    ? await readConfinedFile(resolved.absolutePath, relativePath, resolved.mode)
    : { kind: "absent" as const };
  if (current.kind === "refused") return failure("studio", correlationId, "The existing AgentScan binding could not be read.");
  let action: "create" | "no_change" | "update_origin" = "create";
  let previousSourceOrigin: string | null = null;
  if (current.kind === "file") {
    const plan = classifyExistingBindingForImport({
      text: current.text,
      manifestDigest: intent.manifestDigest,
      manifest: intent.manifest,
      sourceOrigin: intent.sourceOrigin,
    });
    if (plan === null) {
      return failure("studio", correlationId, "An existing AgentScan binding differs; review it before importing.");
    }
    action = plan.action;
    previousSourceOrigin = plan.previousSourceOrigin;
  }
  const saved = registry.setPreview(intentId, {
    intentId,
    projectId,
    scopeVersion: scope.data.scopeVersion,
    manifestDigest: intent.manifestDigest,
    action,
    relativePath,
    fileHash: current.kind === "file" ? current.hash : null,
    previousSourceOrigin,
  });
  if (saved === null) return failure("studio", correlationId, "Import intent is no longer pending.");
  return ok({
    schema: "agentscan.vex.import-preview/1",
    intentId,
    previewToken: saved.previewToken,
    agentVersionId: intent.manifest.agentVersionId,
    manifestDigest: intent.manifestDigest,
    project: { id: scope.data.projectId, name: scope.data.name, scopeVersion: scope.data.scopeVersion },
    change: {
      action,
      relativePath,
      previousSourceOrigin,
      walletAccess: false,
      signing: false,
      execution: false,
    },
  });
}

async function confirmImport(
  intent: ImportIntentRecord,
  preview: NonNullable<ImportIntentRecord["preview"]>,
): Promise<ReturnType<AgentscanImportIntentRegistry["signReceipt"]> | "preview_stale"> {
  const scope = await readProjectRenderScope(preview.projectId);
  if (!scope.ok || scope.data === null || scope.data.scopeVersion !== preview.scopeVersion) return "preview_stale";
  const root = await resolveProjectsRoot(intent.intentId);
  if (!root.ok) return "preview_stale";
  const lexicalDirectory = resolveProjectDirectory(root.data, scope.data.slug);
  if (lexicalDirectory === null) return "preview_stale";
  const directory = await realProjectDirectory(root.data, lexicalDirectory);
  if (!directory.ok) return "preview_stale";
  const resolved = await resolveArtifactPath(directory.directory, preview.relativePath);
  if (resolved.kind === "refused") return "preview_stale";
  const previousSourceOrigin = preview.action === "update_origin"
    ? preview.previousSourceOrigin
    : intent.sourceOrigin;
  if (previousSourceOrigin === null) return "preview_stale";
  const expectedCurrentText = canonicalBindingFile({
    manifestDigest: intent.manifestDigest,
    manifest: intent.manifest,
    sourceOrigin: previousSourceOrigin,
  });
  let changed = true;
  let expectedHash: string | null = null;
  if (resolved.exists) {
    const current = await readConfinedFile(resolved.absolutePath, preview.relativePath, resolved.mode);
    if (current.kind !== "file" || current.text !== expectedCurrentText) return "preview_stale";
    if (!importPreviewFileStateMatches(preview, current.hash)) return "preview_stale";
    changed = preview.action !== "no_change";
    expectedHash = current.hash;
  } else if (!importPreviewFileStateMatches(preview, null)) {
    return "preview_stale";
  }
  if (changed) {
    const written = await replaceConfinedFile({
      projectDirectory: directory.directory,
      absolutePath: resolved.absolutePath,
      relativeLabel: preview.relativePath,
      text: canonicalBindingFile({
        manifestDigest: intent.manifestDigest,
        manifest: intent.manifest,
        sourceOrigin: intent.sourceOrigin,
      }),
      expectedHash,
      mode: resolved.mode,
    });
    if (written.kind === "refused") return "preview_stale";
  }
  let cloudInstall;
  if (intent.manifest.versionUid) {
    // The existing import contract is a safe local metadata approval. Cloud
    // install enrichment is best-effort: a network/backend failure must not
    // be misreported as a stale local preview or undo the confined write.
    try {
      const { completeSignedInstall } = await import("../agentscan/publisher-service.js");
      const installed = await completeSignedInstall(intent.manifest, intent.intentId);
      const runtimePath = await resolveArtifactPath(directory.directory, LOCAL_RUNTIME_BINDING_PATH);
      if (runtimePath.kind !== "refused") {
        const runtimeCurrent = runtimePath.exists
          ? await readConfinedFile(runtimePath.absolutePath, LOCAL_RUNTIME_BINDING_PATH, runtimePath.mode)
          : { kind: "absent" as const };
        const runtimeBinding = {
          schema: "agentscan.vex.local-runtime-binding/1" as const,
          agentUid: installed.agentUid,
          versionUid: installed.versionUid,
          bindingUid: installed.agentBindingUid,
          instanceUid: installed.instanceUid,
          bindingPublisherKeyId: installed.bindingPublisherKeyId,
          manifestDigest: installed.manifestDigest,
          artifactDigest: installed.artifactDigest,
        };
        const expected = canonicalLocalRuntimeBinding(runtimeBinding);
        const existing = runtimeCurrent.kind === "file"
          ? parseLocalRuntimeBinding(runtimeCurrent.text)
          : null;
        // Never overwrite a different durable cloud binding. A failed runtime
        // continuation does not undo the already-approved metadata import.
        if (runtimeCurrent.kind === "absent" || runtimeCurrent.kind === "file" && existing !== null && runtimeCurrent.text === expected) {
          const written = runtimeCurrent.kind === "file" && runtimeCurrent.text === expected
            ? { kind: "written" as const }
            : await replaceConfinedFile({ projectDirectory: directory.directory, absolutePath: runtimePath.absolutePath, relativeLabel: LOCAL_RUNTIME_BINDING_PATH, text: expected, expectedHash: runtimeCurrent.kind === "file" ? runtimeCurrent.hash : null, mode: runtimePath.mode });
          if (written.kind === "written") {
            cloudInstall = { agentUid: installed.agentUid, versionUid: installed.versionUid, publisherUid: installed.publisherUid, publisherKeyId: installed.publisherKeyId, manifestDigest: installed.manifestDigest, artifactDigest: installed.artifactDigest, artifactValidationScope: installed.artifactValidationScope, executionEnabled: installed.executionEnabled, agentBindingUid: installed.agentBindingUid, instanceUid: installed.instanceUid };
          }
        }
      }
    }
    catch { cloudInstall = undefined; }
  }
  return registry.signReceipt({
    intentId: intent.intentId,
    agentVersionId: intent.manifest.agentVersionId,
    manifestDigest: intent.manifestDigest,
    projectRef: opaqueProjectRef(scope.data.projectId),
    projectRevision: String(scope.data.scopeVersion),
    sourceOrigin: intent.sourceOrigin,
    authority: { walletAccess: false, signing: false, execution: false },
    mutation: { kind: "project_metadata_binding", changed },
  }, cloudInstall);
}

export function registerAgentscanImportHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.studio.agentscanImportGetPending,
      domain: "studio",
      inputSchema: agentScanImportGetPendingInputSchema,
      outputSchema: agentScanImportReviewSchema.nullable(),
      handle: async () => ok(registry.getPending()),
    }),
    registerHandler({
      channel: CH.studio.agentscanImportPreview,
      domain: "studio",
      inputSchema: agentScanImportPreviewInputSchema,
      outputSchema: agentScanImportPreviewSchema,
      handle: (input, ctx) => previewImport(input.intentId, input.projectId, input.expectedScopeVersion, ctx.requestId),
    }),
    registerHandler({
      channel: CH.studio.agentscanImportConfirm,
      domain: "studio",
      inputSchema: agentScanImportConfirmInputSchema,
      outputSchema: agentScanImportConfirmResultSchema,
      handle: async (input, ctx) => ok(await registry.confirm(input.intentId, input.previewToken, input.projectId, input.expectedScopeVersion, confirmImport)),
    }),
    registerHandler({
      channel: CH.studio.agentscanImportReject,
      domain: "studio",
      inputSchema: agentScanImportRejectInputSchema,
      outputSchema: agentScanImportRejectResultSchema,
      handle: async (input) => ok({ outcome: registry.reject(input.intentId) }),
    }),
  ];
}
