import { describe, expect, it } from "vitest";
import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import {
  canonicalLocalRuntimeBinding,
  LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST,
  LocalStrategyRuntime,
  parseLocalRuntimeBinding,
  type LocalStrategyBinding,
} from "../local-strategy-runtime.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;
const AGENT_UID = "00000000-0000-4000-8000-000000000002";
const VERSION_UID = "00000000-0000-4000-8000-000000000003";
const BINDING_UID = "00000000-0000-4000-8000-000000000004";
const DEPLOYMENT_UID = "00000000-0000-4000-8000-000000000005";

function portfolio(): PortfolioDto {
  return {
    scope: "project",
    walletCount: 1,
    liveTotalUsd: 125.567,
    snapshotTotalUsd: 100,
    pnlVsPrev: null,
    snapshotAt: "2026-09-10T00:00:00.000Z",
    tokens: [],
    chains: [],
  };
}

function binding(): LocalStrategyBinding {
  return {
    projectId: PROJECT_ID,
    scopeVersion: 3,
    manifestDigest: MANIFEST_DIGEST,
    artifactDigest: ARTIFACT_DIGEST,
    runtimeBundleDigest: LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST,
    agentUid: AGENT_UID,
    versionUid: VERSION_UID,
    bindingUid: BINDING_UID,
  };
}

function runtime(
  readPortfolio: () => Promise<Result<PortfolioDto, VexError>> = async () => ok(portfolio()),
) {
  let current = binding();
  const service = new LocalStrategyRuntime({
    resolveBinding: async (projectId, scopeVersion) => {
      if (projectId !== current.projectId) return { kind: "project_not_found" } as const;
      if (scopeVersion !== current.scopeVersion) return { kind: "scope_changed" } as const;
      return { kind: "ok", binding: current } as const;
    },
    readPortfolio: async () => readPortfolio(),
    reporter: {
      acknowledgeDeployment: async (item) => ({
        deploymentUid: DEPLOYMENT_UID,
        receipt: {
          alg: "Ed25519" as const,
          publicKey: "test-public-key",
          signature: "test-signature",
          signingPayload: {
            schemaVersion: "agentscan.local-runtime-receipt/1" as const,
            action: "local_deployment_ack" as const,
            agentUid: item.agentUid,
            versionUid: item.versionUid,
            bindingUid: item.bindingUid,
            artifactDigest: item.artifactDigest,
            manifestDigest: item.manifestDigest,
            runtimeBundleDigest: item.runtimeBundleDigest,
          },
        },
      }),
      startRun: async () => undefined,
      completeRun: async ({ binding: item }) => ({
        alg: "Ed25519" as const,
        publicKey: "test-public-key",
        signature: "test-signature",
        signingPayload: {
          schemaVersion: "agentscan.local-runtime-receipt/1" as const,
          action: "local_result" as const,
          agentUid: item.agentUid,
          versionUid: item.versionUid,
          bindingUid: item.bindingUid,
          artifactDigest: item.artifactDigest,
          manifestDigest: item.manifestDigest,
          runtimeBundleDigest: item.runtimeBundleDigest,
        },
      }),
    },
  });
  return {
    service,
    changeBinding(next: LocalStrategyBinding) { current = next; },
  };
}

async function terminalRun(service: LocalStrategyRuntime, ownerId: number, runId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = service.get(ownerId, runId);
    if (found.outcome === "found" && found.run.status !== "running") return found.run;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("local strategy did not settle");
}

describe("LocalStrategyRuntime", () => {
  it("accepts only a canonical persistent cloud binding", () => {
    const text = canonicalLocalRuntimeBinding({
      schema: "agentscan.vex.local-runtime-binding/1",
      agentUid: AGENT_UID,
      versionUid: VERSION_UID,
      bindingUid: BINDING_UID,
      instanceUid: DEPLOYMENT_UID,
      bindingPublisherKeyId: "d".repeat(64),
      manifestDigest: MANIFEST_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
    });
    expect(parseLocalRuntimeBinding(text)).toMatchObject({ bindingUid: BINDING_UID });
    expect(parseLocalRuntimeBinding(text.trimEnd())).toBeNull();
  });

  it("binds both digests, computes a sanitized portfolio delta, and returns the publisher receipt", async () => {
    const { service } = runtime();
    const granted = await service.acquire(7, PROJECT_ID, 3);
    expect(granted.outcome).toBe("granted");
    if (granted.outcome !== "granted") return;
    expect(granted.capability).toMatchObject({
      manifestDigest: MANIFEST_DIGEST,
      runtimeBundleDigest: LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST,
      deploymentUid: DEPLOYMENT_UID,
      authority: { portfolioRead: true, walletWrites: false, trading: false, secretAccess: false },
    });

    const started = await service.start(7, granted.capability.capabilityId);
    expect(started.outcome).toBe("started");
    if (started.outcome !== "started") return;
    const settled = await terminalRun(service, 7, started.run.runId);
    expect(settled).toMatchObject({
      status: "completed",
      summary: {
        liveTotalUsd: 125.57,
        baselineTotalUsd: 100,
        changeUsd: 25.57,
        changePercent: 25.57,
      },
      receipt: { signingPayload: { manifestDigest: MANIFEST_DIGEST, runtimeBundleDigest: LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST, action: "local_result" } },
    });
  });

  it("refuses a run when either immutable binding digest changes", async () => {
    const harness = runtime();
    const granted = await harness.service.acquire(7, PROJECT_ID, 3);
    if (granted.outcome !== "granted") throw new Error("capability was not granted");
    harness.changeBinding({ ...binding(), runtimeBundleDigest: `sha256:${"b".repeat(64)}` });
    await expect(harness.service.start(7, granted.capability.capabilityId)).resolves.toEqual({ outcome: "binding_changed" });
  });

  it("stops a delayed read and discards its late result", async () => {
    let resolveRead!: (result: Result<PortfolioDto, VexError>) => void;
    const harness = runtime(() => new Promise((resolve) => { resolveRead = resolve; }));
    const granted = await harness.service.acquire(7, PROJECT_ID, 3);
    if (granted.outcome !== "granted") throw new Error("capability was not granted");
    const started = await harness.service.start(7, granted.capability.capabilityId);
    if (started.outcome !== "started") throw new Error("run was not started");
    const second = await harness.service.acquire(7, PROJECT_ID, 3);
    if (second.outcome !== "granted") throw new Error("second capability was not granted");
    await expect(harness.service.start(7, second.capability.capabilityId)).resolves.toEqual({
      outcome: "run_active",
      runId: started.run.runId,
    });
    expect(harness.service.stop(7, started.run.runId)).toEqual({ outcome: "stopped" });
    resolveRead(ok(portfolio()));
    const settled = await terminalRun(harness.service, 7, started.run.runId);
    expect(settled).toMatchObject({ status: "stopped", summary: null, receipt: null });
  });

  it("times out a bounded run without publishing a late result", async () => {
    const service = new LocalStrategyRuntime({
      resolveBinding: async () => ({ kind: "ok", binding: binding() }),
      readPortfolio: async () => new Promise<Result<PortfolioDto, VexError>>(() => undefined),
      reporter: {
        acknowledgeDeployment: async () => ({ deploymentUid: DEPLOYMENT_UID, receipt: null }),
        startRun: async () => undefined,
        completeRun: async () => { throw new Error("unreachable"); },
      },
      runTimeoutMs: 5,
    });
    const granted = await service.acquire(7, PROJECT_ID, 3);
    if (granted.outcome !== "granted") throw new Error("capability was not granted");
    const started = await service.start(7, granted.capability.capabilityId);
    if (started.outcome !== "started") throw new Error("run was not started");
    const settled = await terminalRun(service, 7, started.run.runId);
    expect(settled).toMatchObject({ status: "timed_out", summary: null, receipt: null });
  });
});
