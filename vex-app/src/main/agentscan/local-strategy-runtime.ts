/**
 * Main-process-only executor for the one audited local AgentScan strategy.
 *
 * This is intentionally not a general agent sandbox. A run executes a closed
 * built-in function with one injected, project-scoped portfolio reader. There
 * is no artifact loader, command runner, MCP client, network primitive, file
 * handle, wallet signer, or secrets handle in this module's API. The timeout
 * and abort controller bound the one read; a late read result is discarded.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Result, VexError } from "@shared/ipc/result.js";
import type { PortfolioDto } from "@shared/schemas/portfolio.js";
import type {
  LocalStrategyCapability,
  LocalStrategyRun,
  LocalStrategyRuntimeAcquireResult,
  LocalStrategyRuntimeGetRunResult,
  LocalStrategyRuntimeRevokeResult,
  LocalStrategyRuntimeStartResult,
  LocalStrategyRuntimeStopResult,
  LocalStrategySummary,
  LocalRuntimeBindingFile,
} from "@shared/schemas/agentscan-local-runtime.js";
import { localRuntimeBindingFileSchema } from "@shared/schemas/agentscan-local-runtime.js";
import { stableStringify } from "./stable-json.js";

const CAPABILITY_TTL_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 8_000;

/**
 * Canonical declaration of the executable bundle. This is intentionally kept
 * separate from the AgentScan publication manifest: the latter is public
 * metadata only. A behavior change requires changing this declaration (and
 * therefore the digest), which invalidates old local capabilities.
 */
const RUNTIME_BUNDLE_SOURCE = [
  "vex.local.strategy.bundle/1",
  "strategy=portfolio_change_summary",
  "input=project_scoped_portfolio_snapshot",
  "summary=live_total_minus_latest_complete_snapshot",
  "capabilities=portfolio_read",
  "denied=wallet_write,trading,secrets,network,filesystem,shell,mcp",
  `timeout_ms=${String(RUN_TIMEOUT_MS)}`,
].join("\n");

export const LOCAL_STRATEGY_RUNTIME_BUNDLE_DIGEST = `sha256:${createHash("sha256")
  .update(RUNTIME_BUNDLE_SOURCE, "utf8")
  .digest("hex")}`;

/** Main-owned continuation of the signed cloud install binding. */
export const LOCAL_RUNTIME_BINDING_PATH = ".vex/agentscan/runtime-binding.json";

export function canonicalLocalRuntimeBinding(binding: LocalRuntimeBindingFile): string {
  return `${stableStringify(localRuntimeBindingFileSchema.parse(binding))}\n`;
}

export function parseLocalRuntimeBinding(text: string): LocalRuntimeBindingFile | null {
  try {
    const parsed = localRuntimeBindingFileSchema.safeParse(JSON.parse(text));
    return parsed.success && canonicalLocalRuntimeBinding(parsed.data) === text ? parsed.data : null;
  } catch {
    return null;
  }
}

const authority = {
  portfolioRead: true,
  walletWrites: false,
  trading: false,
  secretAccess: false,
  remoteExecution: false,
} as const;

export interface LocalStrategyBinding {
  readonly projectId: string;
  readonly scopeVersion: number;
  readonly manifestDigest: string;
  readonly runtimeBundleDigest: string;
  readonly agentUid: string;
  readonly versionUid: string;
  readonly bindingUid: string;
  readonly artifactDigest: string;
}

export interface LocalStrategyReporter {
  acknowledgeDeployment(binding: LocalStrategyBinding): Promise<{
    readonly deploymentUid: string;
    readonly receipt: LocalStrategyRun["receipt"];
  }>;
  startRun(input: {
    readonly binding: LocalStrategyBinding;
    readonly deploymentUid: string;
    readonly runId: string;
    readonly inputSnapshotDigest: string;
  }): Promise<void>;
  completeRun(input: {
    readonly binding: LocalStrategyBinding;
    readonly deploymentUid: string;
    readonly runId: string;
    readonly summary: LocalStrategySummary;
  }): Promise<NonNullable<LocalStrategyRun["receipt"]>>;
}

export type BindingResolution =
  | { readonly kind: "ok"; readonly binding: LocalStrategyBinding }
  | { readonly kind: "project_not_found" | "scope_changed" | "agent_binding_invalid" };

export interface LocalStrategyRuntimeOptions {
  readonly resolveBinding: (projectId: string, expectedScopeVersion: number) => Promise<BindingResolution>;
  readonly readPortfolio: (projectId: string) => Promise<Result<PortfolioDto, VexError>>;
  readonly now?: () => Date;
  readonly capabilityTtlMs?: number;
  readonly runTimeoutMs?: number;
  /** Required in production: signs/reports through VEX's persistent key. */
  readonly reporter?: LocalStrategyReporter;
}

interface CapabilityRecord {
  readonly ownerId: number;
  readonly capability: LocalStrategyCapability;
  readonly binding: LocalStrategyBinding;
  readonly deploymentUid: string;
  revoked: boolean;
}

interface RunRecord {
  readonly ownerId: number;
  readonly capabilityId: string;
  readonly binding: LocalStrategyBinding;
  run: LocalStrategyRun;
  readonly controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | null;
}

function toIso(now: Date): string {
  return now.toISOString();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function summaryFromPortfolio(portfolio: PortfolioDto, observedAt: string): LocalStrategySummary {
  const baseline = portfolio.snapshotTotalUsd;
  const change = baseline === null ? null : roundMoney(portfolio.liveTotalUsd - baseline);
  const changePercent = baseline === null || baseline === 0
    ? null
    : roundMoney(((portfolio.liveTotalUsd - baseline) / Math.abs(baseline)) * 100);
  return {
    kind: "portfolio_change_summary",
    observedAt,
    // Project scope selects at most one wallet in each family. The database
    // remains the source for the actual selected addresses, which never leave
    // its privileged path.
    walletCount: Math.min(2, portfolio.walletCount),
    liveTotalUsd: roundMoney(portfolio.liveTotalUsd),
    baselineTotalUsd: baseline === null ? null : roundMoney(baseline),
    changeUsd: change,
    changePercent,
    baselineAt: portfolio.snapshotAt,
  };
}

function isTerminal(status: LocalStrategyRun["status"]): boolean {
  return status !== "running";
}

export class LocalStrategyRuntime {
  readonly #resolveBinding: LocalStrategyRuntimeOptions["resolveBinding"];
  readonly #readPortfolio: LocalStrategyRuntimeOptions["readPortfolio"];
  readonly #now: () => Date;
  readonly #capabilityTtlMs: number;
  readonly #runTimeoutMs: number;
  readonly #reporter: LocalStrategyReporter | undefined;
  readonly #capabilities = new Map<string, CapabilityRecord>();
  readonly #runs = new Map<string, RunRecord>();

  constructor(options: LocalStrategyRuntimeOptions) {
    this.#resolveBinding = options.resolveBinding;
    this.#readPortfolio = options.readPortfolio;
    this.#now = options.now ?? (() => new Date());
    this.#capabilityTtlMs = options.capabilityTtlMs ?? CAPABILITY_TTL_MS;
    this.#runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    this.#reporter = options.reporter;
  }

  async acquire(ownerId: number, projectId: string, expectedScopeVersion: number): Promise<LocalStrategyRuntimeAcquireResult> {
    const resolved = await this.#resolveBinding(projectId, expectedScopeVersion);
    if (resolved.kind !== "ok") return { outcome: resolved.kind };
    if (this.#reporter === undefined) return { outcome: "reporting_unavailable" };
    let deployment;
    try {
      deployment = await this.#reporter.acknowledgeDeployment(resolved.binding);
    } catch {
      return { outcome: "reporting_unavailable" };
    }
    const now = this.#now();
    const capability: LocalStrategyCapability = {
      capabilityId: randomUUID(),
      strategy: "portfolio_change_summary",
      manifestDigest: resolved.binding.manifestDigest,
      runtimeBundleDigest: resolved.binding.runtimeBundleDigest,
      agentUid: resolved.binding.agentUid,
      versionUid: resolved.binding.versionUid,
      bindingUid: resolved.binding.bindingUid,
      deploymentUid: deployment.deploymentUid,
      expiresAt: toIso(new Date(now.getTime() + this.#capabilityTtlMs)),
      localOnly: true,
      authority,
    };
    this.#capabilities.set(capability.capabilityId, { ownerId, capability, binding: resolved.binding, deploymentUid: deployment.deploymentUid, revoked: false });
    return { outcome: "granted", capability };
  }

  async start(ownerId: number, capabilityId: string): Promise<LocalStrategyRuntimeStartResult> {
    const capability = this.#capabilities.get(capabilityId);
    if (capability === undefined || capability.ownerId !== ownerId) return { outcome: "capability_not_found" };
    if (capability.revoked) return { outcome: "capability_revoked" };
    if (new Date(capability.capability.expiresAt).getTime() <= this.#now().getTime()) return { outcome: "capability_expired" };
    // One in-flight read per renderer owner is the runtime's small local lease:
    // a page cannot fan out capabilities into unbounded database work.
    const active = [...this.#runs.values()].find((run) => run.ownerId === ownerId && !isTerminal(run.run.status));
    if (active !== undefined) return { outcome: "run_active", runId: active.run.runId };

    const current = await this.#resolveBinding(capability.binding.projectId, capability.binding.scopeVersion);
    if (
      current.kind !== "ok"
      || current.binding.manifestDigest !== capability.binding.manifestDigest
      || current.binding.runtimeBundleDigest !== capability.binding.runtimeBundleDigest
    ) {
      return { outcome: "binding_changed" };
    }

    const startedAt = toIso(this.#now());
    const run: LocalStrategyRun = {
      runId: randomUUID(),
      strategy: capability.capability.strategy,
      manifestDigest: capability.binding.manifestDigest,
      runtimeBundleDigest: capability.binding.runtimeBundleDigest,
      agentUid: capability.binding.agentUid,
      versionUid: capability.binding.versionUid,
      bindingUid: capability.binding.bindingUid,
      deploymentUid: capability.deploymentUid,
      status: "running",
      startedAt,
      completedAt: null,
      summary: null,
      failure: null,
      receipt: null,
    };
    const record: RunRecord = {
      ownerId,
      capabilityId,
      binding: capability.binding,
      run,
      controller: new AbortController(),
      timeout: null,
    };
    record.timeout = setTimeout(() => this.#finish(record, "timed_out"), this.#runTimeoutMs);
    this.#runs.set(run.runId, record);
    void this.#execute(record);
    return { outcome: "started", run: record.run };
  }

  get(ownerId: number, runId: string): LocalStrategyRuntimeGetRunResult {
    const record = this.#runs.get(runId);
    return record === undefined || record.ownerId !== ownerId
      ? { outcome: "run_not_found" }
      : { outcome: "found", run: record.run };
  }

  stop(ownerId: number, runId: string): LocalStrategyRuntimeStopResult {
    const record = this.#runs.get(runId);
    if (record === undefined || record.ownerId !== ownerId) return { outcome: "run_not_found" };
    if (isTerminal(record.run.status)) return { outcome: "already_terminal" };
    this.#finish(record, "stopped");
    return { outcome: "stopped" };
  }

  revoke(ownerId: number, capabilityId: string): LocalStrategyRuntimeRevokeResult {
    const capability = this.#capabilities.get(capabilityId);
    if (capability === undefined || capability.ownerId !== ownerId) return { outcome: "capability_not_found" };
    if (capability.revoked) return { outcome: "already_revoked" };
    capability.revoked = true;
    for (const run of this.#runs.values()) {
      if (run.capabilityId === capabilityId && run.ownerId === ownerId && !isTerminal(run.run.status)) {
        this.#finish(run, "revoked");
      }
    }
    return { outcome: "revoked" };
  }

  /** App shutdown only: no unfinished read is allowed to publish a result. */
  dispose(): void {
    for (const record of this.#runs.values()) {
      if (!isTerminal(record.run.status)) this.#finish(record, "revoked");
    }
    this.#capabilities.clear();
  }

  async #execute(record: RunRecord): Promise<void> {
    try {
      const portfolio = await this.#readPortfolio(record.binding.projectId);
      if (record.controller.signal.aborted || isTerminal(record.run.status)) return;
      if (!portfolio.ok) {
        this.#finish(record, "failed", "portfolio_unavailable");
        return;
      }
      const current = await this.#resolveBinding(record.binding.projectId, record.binding.scopeVersion);
      if (record.controller.signal.aborted || isTerminal(record.run.status)) return;
      if (
        current.kind !== "ok"
        || current.binding.manifestDigest !== record.binding.manifestDigest
        || current.binding.runtimeBundleDigest !== record.binding.runtimeBundleDigest
      ) {
        this.#finish(record, "failed", "binding_changed");
        return;
      }
      const summary = summaryFromPortfolio(portfolio.data, toIso(this.#now()));
      const inputSnapshotDigest = `sha256:${createHash("sha256")
        .update(stableStringify(summary), "utf8")
        .digest("hex")}`;
      try {
        if (this.#reporter === undefined) throw new Error("reporter_unavailable");
        await this.#reporter.startRun({
          binding: record.binding,
          deploymentUid: record.run.deploymentUid,
          runId: record.run.runId,
          inputSnapshotDigest,
        });
        if (record.controller.signal.aborted || isTerminal(record.run.status)) return;
        const receipt = await this.#reporter.completeRun({
          binding: record.binding,
          deploymentUid: record.run.deploymentUid,
          runId: record.run.runId,
          summary,
        });
        if (record.controller.signal.aborted || isTerminal(record.run.status)) return;
        this.#finish(record, "completed", undefined, summary, receipt);
      } catch {
        if (!record.controller.signal.aborted && !isTerminal(record.run.status)) this.#finish(record, "failed", "reporting_unavailable");
      }
    } catch {
      if (!record.controller.signal.aborted && !isTerminal(record.run.status)) this.#finish(record, "failed", "execution_failed");
    }
  }

  #finish(
    record: RunRecord,
    status: Exclude<LocalStrategyRun["status"], "running">,
    failure?: NonNullable<LocalStrategyRun["failure"]>,
    summary?: LocalStrategySummary,
    receipt?: LocalStrategyRun["receipt"],
  ): void {
    if (isTerminal(record.run.status)) return;
    record.controller.abort();
    if (record.timeout !== null) clearTimeout(record.timeout);
    const completedAt = toIso(this.#now());
    const terminal: LocalStrategyRun = {
      ...record.run,
      status,
      completedAt,
      summary: summary ?? null,
      failure: failure ?? null,
      receipt: null,
    };
    record.run = { ...terminal, receipt: receipt ?? null };
  }
}
