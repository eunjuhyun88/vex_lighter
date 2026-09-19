/**
 * Typed IPC for VEX's built-in local AgentScan strategy runtime.
 *
 * The browser loopback bridge has no route here. Capability issue, immutable
 * AgentVersion binding, project-scoped portfolio reading, stop and revoke all
 * remain in Electron main, where the project scope and wallet allow-list are
 * authoritative.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  localStrategyRuntimeAcquireInputSchema,
  localStrategyRuntimeAcquireResultSchema,
  localStrategyRuntimeGetRunInputSchema,
  localStrategyRuntimeGetRunResultSchema,
  localStrategyRuntimeRevokeInputSchema,
  localStrategyRuntimeRevokeResultSchema,
  localStrategyRuntimeStartInputSchema,
  localStrategyRuntimeStartResultSchema,
  localStrategyRuntimeStopInputSchema,
  localStrategyRuntimeStopResultSchema,
  type LocalStrategyRuntimeAcquireResult,
  type LocalStrategyRuntimeGetRunResult,
  type LocalStrategyRuntimeRevokeResult,
  type LocalStrategyRuntimeStartResult,
  type LocalStrategyRuntimeStopResult,
} from "@shared/schemas/agentscan-local-runtime.js";
import {
  agentscanVercelRuntimeAcknowledgeInputSchema,
  agentscanVercelRuntimeAcknowledgeResultSchema,
  type AgentscanVercelRuntimeAcknowledgeResult,
} from "@shared/schemas/agentscan-vercel-runtime.js";
import { getPortfolio } from "../database/portfolio-db.js";
import { readProjectRenderScope } from "../database/projects/render-scope.js";
import {
  LocalStrategyRuntime,
  LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST,
  LOCAL_RUNTIME_BINDING_PATH,
  parseLocalRuntimeBinding,
  type BindingResolution,
} from "../agentscan/local-strategy-runtime.js";
import {
  acknowledgeLocalRuntimeDeployment,
  activeRuntimeBindingPublisherKeyId,
  completeLocalRuntimeRun,
  acknowledgeVercelRuntimeDeployment,
  startLocalRuntimeRun,
} from "../agentscan/publisher-service.js";
import { readConfinedFile } from "../studio/installer/confined-fs.js";
import { resolveArtifactPath } from "../studio/installer/paths.js";
import { realProjectDirectory } from "../studio/files/node-path.js";
import { resolveProjectDirectory, resolveProjectsRoot } from "../studio/projects-root.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

async function resolveBinding(
  projectId: string,
  expectedScopeVersion: number,
): Promise<BindingResolution> {
  const scope = await readProjectRenderScope(projectId);
  if (!scope.ok) return { kind: "agent_binding_invalid" };
  if (scope.data === null) return { kind: "project_not_found" };
  if (scope.data.scopeVersion !== expectedScopeVersion) return { kind: "scope_changed" };

  const root = await resolveProjectsRoot("agentscan-local-runtime");
  if (!root.ok) return { kind: "agent_binding_invalid" };
  const lexical = resolveProjectDirectory(root.data, scope.data.slug);
  if (lexical === null) return { kind: "agent_binding_invalid" };
  const project = await realProjectDirectory(root.data, lexical);
  if (!project.ok) return { kind: "agent_binding_invalid" };

  const bindingPath = await resolveArtifactPath(project.directory, LOCAL_RUNTIME_BINDING_PATH);
  if (bindingPath.kind === "refused" || !bindingPath.exists) {
    return { kind: "agent_binding_invalid" };
  }
  const bindingFile = await readConfinedFile(bindingPath.absolutePath, LOCAL_RUNTIME_BINDING_PATH, bindingPath.mode);
  if (bindingFile.kind !== "file") return { kind: "agent_binding_invalid" };
  const binding = parseLocalRuntimeBinding(bindingFile.text);
  if (binding === null) return { kind: "agent_binding_invalid" };
  try {
    if (await activeRuntimeBindingPublisherKeyId() !== binding.bindingPublisherKeyId) {
      return { kind: "agent_binding_invalid" };
    }
  } catch {
    return { kind: "agent_binding_invalid" };
  }
  return {
    kind: "ok",
    binding: {
      projectId,
      scopeVersion: scope.data.scopeVersion,
      manifestDigest: binding.manifestDigest,
      artifactDigest: binding.artifactDigest,
      runtimeBundleDigest: LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST,
      agentUid: binding.agentUid,
      versionUid: binding.versionUid,
      bindingUid: binding.bindingUid,
    },
  };
}

const runtime = new LocalStrategyRuntime({
  resolveBinding,
  readPortfolio: (projectId) => getPortfolio({ scope: "project", projectId }),
  reporter: {
    acknowledgeDeployment: async (binding) => {
      const result = await acknowledgeLocalRuntimeDeployment(binding);
      return { deploymentUid: result.deploymentUid, receipt: result.receipt as never };
    },
    startRun: startLocalRuntimeRun,
    completeRun: async (input) => completeLocalRuntimeRun(input) as never,
  },
});

function ownerId(webContentsId: number): number {
  return webContentsId;
}

export function registerAgentscanLocalRuntimeHandlers(): ReadonlyArray<() => void> {
  const teardowns = [
    registerHandler({
      channel: CH.studio.agentscanLocalRuntimeAcquire,
      domain: "studio",
      inputSchema: localStrategyRuntimeAcquireInputSchema,
      outputSchema: localStrategyRuntimeAcquireResultSchema,
      handle: async (input, ctx): Promise<Result<LocalStrategyRuntimeAcquireResult>> => {
        const outcome = await runtime.acquire(ownerId(ctx.event.sender.id), input.projectId, input.expectedScopeVersion);
        log.info(`[ipc:vex:studio:agentscanLocalRuntimeAcquire] outcome=${outcome.outcome} correlationId=${ctx.requestId}`);
        return ok(outcome);
      },
    }),
    registerHandler({
      channel: CH.studio.agentscanVercelRuntimeAcknowledge,
      domain: "studio",
      inputSchema: agentscanVercelRuntimeAcknowledgeInputSchema,
      outputSchema: agentscanVercelRuntimeAcknowledgeResultSchema,
      handle: async (input, ctx): Promise<Result<AgentscanVercelRuntimeAcknowledgeResult>> => {
        const binding = await resolveBinding(input.projectId, input.expectedScopeVersion);
        if (binding.kind !== "ok") return ok({ outcome: binding.kind });
        try {
          const deployment = await acknowledgeVercelRuntimeDeployment(binding.binding, input.origin, input.vercelDeploymentId);
          log.info(`[ipc:vex:studio:agentscanVercelRuntimeAcknowledge] outcome=acknowledged correlationId=${ctx.requestId}`);
          return ok({ outcome: "acknowledged", ...deployment });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          return ok({ outcome: message.includes("health_unavailable") ? "runtime_unreachable" : message.includes("health_invalid") || message.includes("endpoint_invalid") ? "runtime_invalid" : "reporting_unavailable" });
        }
      },
    }),
    registerHandler({
      channel: CH.studio.agentscanLocalRuntimeStart,
      domain: "studio",
      inputSchema: localStrategyRuntimeStartInputSchema,
      outputSchema: localStrategyRuntimeStartResultSchema,
      handle: async (input, ctx): Promise<Result<LocalStrategyRuntimeStartResult>> => {
        const outcome = await runtime.start(ownerId(ctx.event.sender.id), input.capabilityId);
        log.info(`[ipc:vex:studio:agentscanLocalRuntimeStart] outcome=${outcome.outcome} correlationId=${ctx.requestId}`);
        return ok(outcome);
      },
    }),
    registerHandler({
      channel: CH.studio.agentscanLocalRuntimeGetRun,
      domain: "studio",
      inputSchema: localStrategyRuntimeGetRunInputSchema,
      outputSchema: localStrategyRuntimeGetRunResultSchema,
      handle: async (input, ctx): Promise<Result<LocalStrategyRuntimeGetRunResult>> =>
        ok(runtime.get(ownerId(ctx.event.sender.id), input.runId)),
    }),
    registerHandler({
      channel: CH.studio.agentscanLocalRuntimeStop,
      domain: "studio",
      inputSchema: localStrategyRuntimeStopInputSchema,
      outputSchema: localStrategyRuntimeStopResultSchema,
      handle: async (input, ctx): Promise<Result<LocalStrategyRuntimeStopResult>> =>
        ok(runtime.stop(ownerId(ctx.event.sender.id), input.runId)),
    }),
    registerHandler({
      channel: CH.studio.agentscanLocalRuntimeRevoke,
      domain: "studio",
      inputSchema: localStrategyRuntimeRevokeInputSchema,
      outputSchema: localStrategyRuntimeRevokeResultSchema,
      handle: async (input, ctx): Promise<Result<LocalStrategyRuntimeRevokeResult>> =>
        ok(runtime.revoke(ownerId(ctx.event.sender.id), input.capabilityId)),
    }),
  ];
  return [...teardowns, () => runtime.dispose()];
}
