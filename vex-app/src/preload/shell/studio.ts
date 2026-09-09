import { CH, EV } from "../../shared/ipc/channels.js";
import { studioHostStatusSchema } from "../../shared/schemas/studio.js";
import {
  agentScanImportConfirmInputSchema,
  agentScanImportEventSchema,
  agentScanImportPreviewInputSchema,
  agentScanImportRejectInputSchema,
} from "../../shared/schemas/agentscan-import.js";
import type { StudioBridge } from "../../shared/types/bridge/shell/studio.js";
import {
  publicationConfirmInputSchema,
  publicationIntentEventSchema,
  publicationPreviewInputSchema,
  publicationRejectInputSchema,
} from "../../shared/schemas/agentscan-publication.js";
import {
  localStrategyRuntimeAcquireInputSchema,
  localStrategyRuntimeGetRunInputSchema,
  localStrategyRuntimeRevokeInputSchema,
  localStrategyRuntimeStartInputSchema,
  localStrategyRuntimeStopInputSchema,
} from "../../shared/schemas/agentscan-local-runtime.js";
import { agentscanVercelRuntimeAcknowledgeInputSchema } from "../../shared/schemas/agentscan-vercel-runtime.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * vex.studio.* - the read-only Vex Studio bridge (host status, stage B0; bridge
 * readiness, stage B1.6).
 *
 * Business methods only; the renderer never sees a raw channel and never
 * learns the host's endpoint - the payload has no field to carry one, and its
 * `.strict()` schema drops any that appears. Status updates arrive via
 * `onHostStatus` (main-pushed, Zod-validated here, off-contract payloads
 * dropped before the callback runs). Mirrors `shell/market.ts`.
 */
export const studio = {
  getHostStatus() {
    return invokeWithSchema(CH.studio.hostStatus, {});
  },
  onHostStatus(cb) {
    return subscribe(EV.studio.hostStatus, studioHostStatusSchema, cb);
  },
  getBridgeReadiness() {
    return invokeWithSchema(CH.studio.bridgeReadiness, {});
  },
  agentscanImportGetPending() {
    return invokeWithSchema(CH.studio.agentscanImportGetPending, {});
  },
  agentscanImportPreview(input) {
    return invokeWithSchema(CH.studio.agentscanImportPreview, input, agentScanImportPreviewInputSchema);
  },
  agentscanImportConfirm(input) {
    return invokeWithSchema(CH.studio.agentscanImportConfirm, input, agentScanImportConfirmInputSchema);
  },
  agentscanImportReject(input) {
    return invokeWithSchema(CH.studio.agentscanImportReject, input, agentScanImportRejectInputSchema);
  },
  onAgentscanImportIntent(cb) {
    return subscribe(EV.studio.agentscanImportIntent, agentScanImportEventSchema, cb);
  },
  agentscanPublicationGetPending() {
    return invokeWithSchema(CH.studio.agentscanPublicationGetPending, {});
  },
  agentscanPublicationPreview(input) {
    return invokeWithSchema(CH.studio.agentscanPublicationPreview, input, publicationPreviewInputSchema);
  },
  agentscanPublicationConfirm(input) {
    return invokeWithSchema(CH.studio.agentscanPublicationConfirm, input, publicationConfirmInputSchema);
  },
  agentscanPublicationReject(input) {
    return invokeWithSchema(CH.studio.agentscanPublicationReject, input, publicationRejectInputSchema);
  },
  onAgentscanPublicationIntent(cb) {
    return subscribe(EV.studio.agentscanPublicationIntent, publicationIntentEventSchema, cb);
  },
  agentscanLocalRuntimeAcquire(input) {
    return invokeWithSchema(CH.studio.agentscanLocalRuntimeAcquire, input, localStrategyRuntimeAcquireInputSchema);
  },
  agentscanLocalRuntimeStart(input) {
    return invokeWithSchema(CH.studio.agentscanLocalRuntimeStart, input, localStrategyRuntimeStartInputSchema);
  },
  agentscanLocalRuntimeGetRun(input) {
    return invokeWithSchema(CH.studio.agentscanLocalRuntimeGetRun, input, localStrategyRuntimeGetRunInputSchema);
  },
  agentscanLocalRuntimeStop(input) {
    return invokeWithSchema(CH.studio.agentscanLocalRuntimeStop, input, localStrategyRuntimeStopInputSchema);
  },
  agentscanLocalRuntimeRevoke(input) {
    return invokeWithSchema(CH.studio.agentscanLocalRuntimeRevoke, input, localStrategyRuntimeRevokeInputSchema);
  },
  agentscanVercelRuntimeAcknowledge(input) {
    return invokeWithSchema(CH.studio.agentscanVercelRuntimeAcknowledge, input, agentscanVercelRuntimeAcknowledgeInputSchema);
  },
} satisfies StudioBridge;
