import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  DIALOG_INITIAL_FOCUS,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Button } from "../../../components/ui/button.js";
import { SelectMenu } from "../../../components/ui/select-menu.js";
import { SubmitError } from "../../../components/ui/submit-error.js";
import { useProjects } from "../../../lib/api/projects.js";
import { useUiStore } from "../../../stores/uiStore.js";
import type {
  AgentScanImportPreview,
  AgentScanImportReview,
} from "@shared/schemas/agentscan-import.js";

/** The single, app-wide AgentScan import review surface. It only binds metadata. */
export function AgentScanImportHost(): JSX.Element | null {
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const projects = useProjects();
  const [review, setReview] = useState<AgentScanImportReview | null>(null);
  const [projectId, setProjectId] = useState("");
  const [preview, setPreview] = useState<AgentScanImportPreview | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestVersion = useRef(0);

  const open = useCallback((next: AgentScanImportReview | null) => {
    setReview(next);
    setPreview(null);
    setChecked(false);
    setBusy(false);
    setError(null);
    if (next !== null) setRuntimeMode("studio");
  }, [setRuntimeMode]);
  const refreshPending = useCallback(async (): Promise<void> => {
    const expectedVersion = ++requestVersion.current;
    try {
      const result = await window.vex.studio.agentscanImportGetPending();
      if (expectedVersion !== requestVersion.current) return;
      if (result.ok) open(result.data);
      else setError(result.error.message);
    } catch {
      if (expectedVersion === requestVersion.current) {
        setError("Unable to read the pending AgentScan import.");
      }
    }
  }, [open]);

  useEffect(() => {
    const unsubscribe = window.vex.studio.onAgentscanImportIntent(() => {
      void refreshPending();
    });
    void refreshPending();
    return unsubscribe;
  }, [refreshPending]);

  useEffect(() => {
    if (review === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [review]);

  const available = projects.data?.ok ? projects.data.data : [];
  const selected = available.find((p) => p.id === projectId);
  const selectProject = (id: string): void => {
    setProjectId(id); setPreview(null); setChecked(false); setActiveProjectId(id);
  };
  const loadPreview = async (): Promise<void> => {
    if (review === null || selected === undefined) return;
    const version = requestVersion.current;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await window.vex.studio.agentscanImportPreview({
        intentId: review.intentId,
        projectId: selected.id,
        expectedScopeVersion: selected.scopeVersion,
      });
    } catch {
      if (version === requestVersion.current) {
        setBusy(false);
        setError("Unable to preview this AgentScan import.");
      }
      return;
    }
    if (version !== requestVersion.current) return;
    setBusy(false);
    if (result.ok) setPreview(result.data);
    else setError(result.error.message);
  };
  const expired = review !== null && Date.parse(review.expiresAt) <= now;
  const close = async (): Promise<void> => {
    if (busy || review === null) return;
    const version = requestVersion.current;
    const intentId = review.intentId;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await window.vex.studio.agentscanImportReject({ intentId });
    } catch {
      if (version === requestVersion.current) {
        setBusy(false);
        setError("Unable to reject this AgentScan import.");
      }
      return;
    }
    if (version !== requestVersion.current) return;
    setBusy(false);
    if (result.ok) await refreshPending();
    else setError(result.error.message);
  };
  const confirm = async (): Promise<void> => {
    if (!review || !selected || !preview || !checked) return;
    if (busy || expired) return;
    const version = requestVersion.current;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await window.vex.studio.agentscanImportConfirm({
        intentId: review.intentId,
        projectId: selected.id,
        expectedScopeVersion: selected.scopeVersion,
        previewToken: preview.previewToken,
      });
    } catch {
      if (version === requestVersion.current) {
        setBusy(false);
        setError("Unable to confirm this AgentScan import.");
      }
      return;
    }
    if (version !== requestVersion.current) return;
    setBusy(false);
    if (version !== requestVersion.current) return;
    if (!result.ok) setError(result.error.message);
    else if (result.data.outcome === "approved" || result.data.outcome === "already_approved") {
      await refreshPending();
    }
    else {
      setPreview(null);
      setError(result.data.outcome === "preview_stale" ? "This preview is stale. Review the changes again." : `Import ${result.data.outcome}.`);
    }
  };
  const projectError = projects.data !== undefined && !projects.data.ok
    ? projects.data.error.message
    : null;
  const previewChange = preview?.change;
  const options = useMemo(
    () => available.map((p) => ({ value: p.id, label: p.name })),
    [available],
  );
  if (review === null) return null;
  return <Dialog open onOpenChange={(next) => { if (!next) void close(); }}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>Review AgentScan import</DialogTitle><DialogDescription>Import binds catalog metadata to a Studio project. It does not execute, sign, deploy, or grant wallet access.</DialogDescription></DialogHeader>
      <DialogBody className="gap-4">
        <div className="rounded-lg border border-line-2 bg-surface-1 p-4 text-sm">
          <div className="vex-eyebrow mb-2">AgentVersion</div>
          <div className="text-base font-semibold">{review.manifest.name} · {review.manifest.version}</div>
          <div className="mt-1 text-ink-secondary">{review.manifest.summary}</div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-tertiary">Creator</dt><dd>{review.manifest.creator}</dd>
            <dt className="text-ink-tertiary">Category</dt><dd>{review.manifest.category}</dd>
            <dt className="text-ink-tertiary">Chain</dt><dd>{review.manifest.chain}</dd>
            <dt className="text-ink-tertiary">Digest</dt><dd className="truncate">{review.manifestDigest}</dd>
          </dl>
        </div>
        <label className="text-sm font-medium">Studio project
          <SelectMenu
            ariaLabel="Studio project"
            value={projectId}
            options={options}
            onChange={selectProject}
            placeholder={projects.isPending ? "Loading projects…" : "Choose a project…"}
            disabled={projects.isPending || options.length === 0}
            className="mt-2"
          />
        </label>
        {projectError ? <SubmitError submitError={projectError} /> : null}
        {!projects.isPending && projectError === null && options.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            Create a Studio project before importing this AgentVersion.
          </p>
        ) : null}
        {expired ? (
          <p className="text-sm text-danger" data-testid="agentscan-import-expired">
            This import request has expired. Reject it to dismiss.
          </p>
        ) : null}
        {!expired && selected && !preview ? (
          <Button variant="outline" onClick={() => void loadPreview()} disabled={busy}>
            Preview changes
          </Button>
        ) : null}
        {preview ? (
          <div className="rounded-lg border border-line-2 bg-surface-1 p-4 text-sm">
            <div className="font-semibold">
              {previewChange?.action === "create"
                ? "Creates"
                : previewChange?.action === "update_origin"
                  ? "Updates source origin"
                  : "No changes to make"}
              {previewChange?.action === "update_origin" ? null : ` ${previewChange?.relativePath ?? ""}`}
            </div>
            {previewChange?.action === "update_origin" ? (
              <p className="mt-2" data-testid="agentscan-import-origin-change">
                {previewChange.previousSourceOrigin ?? "Unknown origin"} → {review.sourceOrigin}
              </p>
            ) : null}
            <p className="mt-2 text-ink-secondary">
              Wallet access: none · Signing: none · Execution: none
            </p>
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>I reviewed this exact metadata-only change and want to bind it to this project.</span>
            </label>
          </div>
        ) : null}
        <SubmitError submitError={error} />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => void close()} disabled={busy} {...DIALOG_INITIAL_FOCUS}>
          Reject / cancel
        </Button>
        <Button variant="accent" onClick={() => void confirm()} disabled={!preview || !checked || busy || expired}>
          {busy ? "Working…" : "Confirm import"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
