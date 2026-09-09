import { useCallback, useEffect, useState, type JSX } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { SubmitError } from "../../../components/ui/submit-error.js";
import { useProjects } from "../../../lib/api/projects.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type {
  LocalStrategyCapability,
  LocalStrategyRun,
} from "@shared/schemas/agentscan-local-runtime.js";

function runtimeMessage(outcome: string): string {
  switch (outcome) {
    case "agent_binding_invalid":
      return "Import this AgentVersion into the selected Studio project before running its local summary.";
    case "reporting_unavailable":
      return "AgentScan reporting is unavailable. Reconnect it before starting a local run.";
    case "scope_changed":
      return "This project changed. Acquire a new local capability.";
    case "portfolio_unavailable":
      return "The selected project portfolio is unavailable.";
    default:
      return `Local runtime ${outcome.replaceAll("_", " ")}.`;
  }
}

/**
 * Small Studio control for VEX's closed, read-only portfolio-change strategy.
 * Main re-resolves the project, cloud binding and wallet scope on every action;
 * this component retains only opaque capability and run identifiers.
 */
export function LocalStrategyRuntimeHost(): JSX.Element | null {
  const runtimeMode = useUiStore((state) => state.runtimeMode);
  const activeProjectId = useUiStore((state) => state.activeProjectId);
  const projects = useProjects();
  const project = projects.data?.ok
    ? projects.data.data.find((item) => item.id === activeProjectId) ?? null
    : null;
  const [capability, setCapability] = useState<LocalStrategyCapability | null>(null);
  const [run, setRun] = useState<LocalStrategyRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState("");
  const [vercelDeploymentId, setVercelDeploymentId] = useState("");
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);

  useEffect(() => {
    setCapability(null);
    setRun(null);
    setError(null);
    setAcknowledgement(null);
  }, [activeProjectId]);

  const refreshRun = useCallback(async (runId: string): Promise<void> => {
    try {
      const result = await window.vex.studio.agentscanLocalRuntimeGetRun({ runId });
      if (!result.ok) {
        setError(result.error.message);
      } else if (result.data.outcome === "found") {
        setRun(result.data.run);
      }
    } catch {
      setError("Unable to refresh the local runtime result.");
    }
  }, []);

  useEffect(() => {
    if (run?.status !== "running") return undefined;
    const timer = window.setInterval(() => { void refreshRun(run.runId); }, 750);
    return () => window.clearInterval(timer);
  }, [refreshRun, run?.runId, run?.status]);

  const acquire = useCallback(async (): Promise<void> => {
    if (project === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.vex.studio.agentscanLocalRuntimeAcquire({
        projectId: project.id,
        expectedScopeVersion: project.scopeVersion,
      });
      if (!result.ok) setError(result.error.message);
      else if (result.data.outcome === "granted") setCapability(result.data.capability);
      else setError(runtimeMessage(result.data.outcome));
    } catch {
      setError("Unable to acquire a local runtime capability.");
    } finally {
      setBusy(false);
    }
  }, [busy, project]);

  const start = useCallback(async (): Promise<void> => {
    if (capability === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.vex.studio.agentscanLocalRuntimeStart({
        capabilityId: capability.capabilityId,
      });
      if (!result.ok) setError(result.error.message);
      else if (result.data.outcome === "started") setRun(result.data.run);
      else if (result.data.outcome === "run_active") await refreshRun(result.data.runId);
      else setError(runtimeMessage(result.data.outcome));
    } catch {
      setError("Unable to start the local runtime.");
    } finally {
      setBusy(false);
    }
  }, [busy, capability, refreshRun]);

  const stop = useCallback(async (): Promise<void> => {
    if (run?.status !== "running" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.vex.studio.agentscanLocalRuntimeStop({ runId: run.runId });
      if (!result.ok) setError(result.error.message);
      else if (result.data.outcome === "stopped") await refreshRun(run.runId);
      else setError(runtimeMessage(result.data.outcome));
    } catch {
      setError("Unable to stop the local runtime.");
    } finally {
      setBusy(false);
    }
  }, [busy, refreshRun, run]);

  const revoke = useCallback(async (): Promise<void> => {
    if (capability === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.vex.studio.agentscanLocalRuntimeRevoke({
        capabilityId: capability.capabilityId,
      });
      if (!result.ok) setError(result.error.message);
      else if (result.data.outcome === "revoked" || result.data.outcome === "already_revoked") {
        setCapability(null);
      } else setError(runtimeMessage(result.data.outcome));
    } catch {
      setError("Unable to revoke the local runtime capability.");
    } finally {
      setBusy(false);
    }
  }, [busy, capability]);

  const acknowledgePublicRuntime = useCallback(async (): Promise<void> => {
    if (project === null || busy) return;
    setBusy(true);
    setError(null);
    setAcknowledgement(null);
    try {
      const result = await window.vex.studio.agentscanVercelRuntimeAcknowledge({
        projectId: project.id,
        expectedScopeVersion: project.scopeVersion,
        origin: publicOrigin,
        vercelDeploymentId,
      });
      if (!result.ok) setError(result.error.message);
      else if (result.data.outcome === "acknowledged") {
        setAcknowledgement(`Acknowledged ${result.data.endpoint} (${result.data.runtimeBundleDigest.slice(0, 18)}…).`);
      } else setError(runtimeMessage(result.data.outcome));
    } catch {
      setError("Unable to acknowledge the public runtime.");
    } finally {
      setBusy(false);
    }
  }, [busy, project, publicOrigin, vercelDeploymentId]);

  if (runtimeMode !== "studio" || project === null) return null;
  const terminal = run !== null && run.status !== "running";
  return (
    <aside
      className="fixed bottom-5 right-5 z-30 w-80 rounded-xl border border-line-2 bg-surface-1 p-4 shadow-xl"
      data-testid="agentscan-local-runtime"
    >
      <div className="vex-eyebrow">Local strategy</div>
      <h2 className="mt-1 text-sm font-semibold">Portfolio change summary</h2>
      <p className="mt-1 text-xs text-ink-secondary">
        Read-only. No trades, wallet writes, secrets, or loopback execution.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void acquire()} disabled={busy}>
          {capability === null ? "Acquire" : "Reacquire"}
        </Button>
        <Button size="sm" variant="accent" onClick={() => void start()} disabled={busy || capability === null || run?.status === "running"}>
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={() => void stop()} disabled={busy || run?.status !== "running"}>
          Stop
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void revoke()} disabled={busy || capability === null}>
          Revoke
        </Button>
      </div>
      {run ? (
        <div className="mt-3 rounded-lg border border-line-2 bg-surface-0 p-3 text-xs">
          <div className="font-medium">Run {run.status.replaceAll("_", " ")}</div>
          {run.summary ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-ink-tertiary">Live total</dt><dd>${run.summary.liveTotalUsd.toFixed(2)}</dd>
              <dt className="text-ink-tertiary">Change</dt><dd>{run.summary.changeUsd === null ? "—" : `$${run.summary.changeUsd.toFixed(2)}`}</dd>
              <dt className="text-ink-tertiary">Change %</dt><dd>{run.summary.changePercent === null ? "—" : `${run.summary.changePercent.toFixed(2)}%`}</dd>
              <dt className="text-ink-tertiary">Wallets</dt><dd>{run.summary.walletCount}</dd>
            </dl>
          ) : null}
          {run.failure ? <p className="mt-2 text-danger">{runtimeMessage(run.failure)}</p> : null}
          {terminal && run.receipt ? (
            <div className="mt-2 border-t border-line-2 pt-2 text-[11px] text-ink-secondary">
              <div>Receipt: {run.receipt.signature.slice(0, 18)}…</div>
              <div className="truncate">Manifest: {run.manifestDigest}</div>
              <div className="truncate">Runtime: {run.runtimeBundleDigest}</div>
            </div>
          ) : null}
        </div>
      ) : null}
      <SubmitError submitError={error} />
      <div className="mt-3 border-t border-line-2 pt-3">
        <div className="vex-eyebrow">Public runtime acknowledgement</div>
        <p className="mt-1 text-[11px] text-ink-secondary">Validates `/api/health` before VEX signs an acknowledgement. It does not deploy or run the public runtime.</p>
        <Input className="mt-2 h-8 text-xs" value={publicOrigin} onChange={(event) => setPublicOrigin(event.target.value)} placeholder="https://deployment.vercel.app/" aria-label="Public runtime origin" />
        <Input className="mt-2 h-8 text-xs" value={vercelDeploymentId} onChange={(event) => setVercelDeploymentId(event.target.value)} placeholder="dpl_…" aria-label="Vercel deployment id" />
        <Button className="mt-2" size="sm" variant="outline" onClick={() => void acknowledgePublicRuntime()} disabled={busy || publicOrigin.length === 0 || vercelDeploymentId.length === 0}>
          Acknowledge public runtime
        </Button>
        {acknowledgement ? <p className="mt-2 text-[11px] text-ink-secondary">{acknowledgement}</p> : null}
      </div>
    </aside>
  );
}
