import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Input } from "../../../components/ui/input.js";
import { SelectMenu } from "../../../components/ui/select-menu.js";
import { SubmitError } from "../../../components/ui/submit-error.js";
import { useProjects } from "../../../lib/api/projects.js";
import {
  localAgentPublicProfileSchema,
  type LocalAgentPublicProfileDraft,
  type PublicationFailureCode,
  type PublicationIntentReview,
  type PublicationPreview,
} from "@shared/schemas/agentscan-publication.js";
import type { ProjectDto } from "@shared/schemas/projects.js";

function draftFromProfileJson(text: string): LocalAgentPublicProfileDraft | null {
  try {
    const parsed = localAgentPublicProfileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return null;
    }

    return {
      name: parsed.data.manifest.name,
      summary: parsed.data.manifest.summary,
      semver: parsed.data.semver,
      capabilities: parsed.data.manifest.capabilities,
      inputs: parsed.data.manifest.inputs,
      outputs: parsed.data.manifest.outputs,
    };
  } catch {
    return null;
  }
}

function isExpiredPublicationError(error: {
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): boolean {
  return (
    error.details?.reason === "intent_expired" ||
    /publication intent (?:is )?(?:no longer pending|expired)|intent expired/i.test(
      error.message,
    )
  );
}

function isMissingPublicProfileError(error: {
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): boolean {
  return (
    error.details?.reason === "public_profile_missing" ||
    /no VEX public profile/i.test(error.message)
  );
}

function publicationFailureMessage(code: PublicationFailureCode): string {
  switch (code) {
    case "unavailable":
      return "AgentScan is unavailable. Check the connection, then start a new publication request.";
    case "unauthorized":
      return "This VEX installation is no longer authorized with AgentScan. Reconnect it, then start a new publication request.";
    case "invalid_response":
      return "AgentScan returned an incompatible publication response. Update AgentScan, then start a new publication request.";
    case "rejected":
      return "AgentScan rejected this publication. Review the public profile, then start a new publication request.";
    case "not_ready":
      return "AgentScan reporting is not connected in VEX. Reconnect it, then start a new publication request.";
    case "publisher_key_mismatch":
      return "The saved Publisher Key no longer matches this agent. Recover the key binding before publishing again.";
    default:
      return "VEX could not complete this publication. Start a new publication request and try again.";
  }
}

function parseRows(
  value: string,
  inputs: boolean,
): LocalAgentPublicProfileDraft["inputs"] | LocalAgentPublicProfileDraft["outputs"] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|").map((part) => part.trim()))
    .map((parts) =>
      inputs
        ? {
            name: parts[0] ?? "",
            description: parts[1] ?? "",
            required: parts[2]?.toLowerCase() !== "optional",
          }
        : { name: parts[0] ?? "", description: parts[1] ?? "" },
    ) as LocalAgentPublicProfileDraft["inputs"] | LocalAgentPublicProfileDraft["outputs"];
}

/** The only VEX surface that can approve a browser publication request. */
export function AgentScanPublicationHost(): JSX.Element | null {
  const projects = useProjects();
  const [review, setReview] = useState<PublicationIntentReview | null>(null);
  const [projectId, setProjectId] = useState("");
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<LocalAgentPublicProfileDraft>({
    name: "",
    summary: "",
    semver: "1.0.0",
    capabilities: [],
    inputs: [],
    outputs: [],
  });
  const [profileMode, setProfileMode] = useState<"idle" | "saved" | "edit">("idle");
  const [expired, setExpired] = useState(false);
  // A selection can trigger filesystem I/O. Ignore a late response after a
  // different project, intent, or refresh has superseded it.
  const operation = useRef(0);
  const surfaceError = useCallback((error: {
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): void => {
    if (isExpiredPublicationError(error)) {
      setExpired(true);
      setPreview(null);
      setChecked(false);
      setError(null);
    } else {
      setExpired(false);
      setError(error.message);
    }
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const currentOperation = ++operation.current;
    let result;
    try {
      result = await window.vex.studio.agentscanPublicationGetPending();
    } catch {
      if (currentOperation === operation.current) {
        setBusy(false);
        surfaceError({ message: "Unable to read the pending AgentScan publication." });
      }
      return;
    }
    if (currentOperation !== operation.current) return;
    setBusy(false);
    if (result.ok) {
      setReview(result.data);
      setProjectId("");
      setPreview(null);
      setChecked(false);
      setProfileMode("idle");
      setExpired(false);
      setError(null);
    } else surfaceError(result.error);
  }, [surfaceError]);
  useEffect(() => {
    void refresh();
    return window.vex.studio.onAgentscanPublicationIntent(() => {
      void refresh();
    });
  }, [refresh]);
  const available = projects.data?.ok ? projects.data.data : [];
  const selected = available.find((item) => item.id === projectId);
  const options = useMemo(
    () => available.map((item) => ({ value: item.id, label: item.name })),
    [available],
  );
  const runPreview = useCallback(async ({
    targetReview,
    targetProject,
    withDraft,
    draft,
    currentOperation,
  }: {
    targetReview: PublicationIntentReview;
    targetProject: ProjectDto;
    withDraft: boolean;
    draft?: LocalAgentPublicProfileDraft;
    currentOperation: number;
  }): Promise<void> => {
    if (currentOperation !== operation.current) return;
    setBusy(true);
    setExpired(false);
    setError(null);
    let result;
    try {
      result = await window.vex.studio.agentscanPublicationPreview({
        intentId: targetReview.intentId,
        projectId: targetProject.id,
        expectedScopeVersion: targetProject.scopeVersion,
        ...(targetReview.mode === "local_project" && withDraft && draft ? { profile: draft } : {}),
      });
    } catch {
      if (currentOperation === operation.current) {
        setBusy(false);
        setError("Unable to preview this AgentScan publication.");
      }
      return;
    }
    if (currentOperation !== operation.current) return;
    setBusy(false);
    if (result.ok) {
      setPreview(result.data);
      if (targetReview.mode === "local_project" && result.data.profileJson) {
        const saved = draftFromProfileJson(result.data.profileJson);
        if (saved) {
          setProfile(saved);
          setProfileMode("saved");
        }
      }
    } else if (isMissingPublicProfileError(result.error)) {
      // A missing profile is an expected first-use state. The editor is
      // opened with the explicit project name only; no project internals are
      // scanned or guessed.
      setProfileMode("edit");
      setProfile((current) =>
        current.name === targetProject.name
          ? current
          : { ...current, name: targetProject.name },
      );
    } else surfaceError(result.error);
  }, [surfaceError]);
  useEffect(() => {
    if (!selected || !review || review.mode !== "local_project" || profileMode !== "idle") {
      return;
    }

    const currentOperation = ++operation.current;
    void runPreview({
      targetReview: review,
      targetProject: selected,
      withDraft: false,
      currentOperation,
    });
  }, [profileMode, review, selected, runPreview]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!review) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [review]);
  const deadlineExpired = review !== null && Date.parse(review.expiresAt) <= now;
  useEffect(() => {
    if (!deadlineExpired) return;
    ++operation.current;
    setBusy(false);
    setExpired(true);
    setPreview(null);
    setChecked(false);
  }, [deadlineExpired]);
  if (!review) return null;
  const requestedVersion = review.request?.version;
  const reject = async (): Promise<void> => {
    if (busy) return;
    const currentOperation = ++operation.current;
    setBusy(true);
    let result;
    try {
      result = await window.vex.studio.agentscanPublicationReject({ intentId: review.intentId });
    } catch {
      if (currentOperation === operation.current) {
        setBusy(false);
        setError("Unable to cancel this AgentScan publication.");
      }
      return;
    }
    if (currentOperation !== operation.current) return;
    setBusy(false);
    if (result.ok) await refresh(); else surfaceError(result.error);
  };
  const loadPreview = async (withDraft: boolean): Promise<void> => {
    if (!selected) return;
    const currentOperation = ++operation.current;
    await runPreview({
      targetReview: review,
      targetProject: selected,
      withDraft,
      draft: withDraft ? profile : undefined,
      currentOperation,
    });
  };
  const updateProfile = (change: Partial<LocalAgentPublicProfileDraft>): void => {
    setProfileMode("edit");
    setProfile((current) => ({ ...current, ...change }));
    setPreview(null);
    setChecked(false);
    setExpired(false);
    setError(null);
  };
  const beginProfileEdit = (): void => {
    setProfileMode("edit");
    setPreview(null);
    setChecked(false);
    setExpired(false);
    setError(null);
  };
  const confirm = async (): Promise<void> => {
    if (!selected || !preview || !checked || busy || deadlineExpired || expired) return;
    const currentOperation = ++operation.current;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await window.vex.studio.agentscanPublicationConfirm({
        intentId: review.intentId,
        projectId: selected.id,
        expectedScopeVersion: selected.scopeVersion,
        previewToken: preview.previewToken,
      });
    } catch {
      if (currentOperation === operation.current) {
        setBusy(false);
        setError("Unable to confirm this AgentScan publication.");
      }
      return;
    }
    if (currentOperation !== operation.current) return;
    setBusy(false);
    if (!result.ok) {
      surfaceError(result.error);
    } else if (
      result.data.outcome === "approved" ||
      result.data.outcome === "already_approved"
    ) {
      await refresh();
    } else if (result.data.outcome === "expired") {
      setPreview(null);
      setChecked(false);
      setExpired(true);
      setError(null);
    } else if (result.data.outcome === "failed") {
      setPreview(null);
      setChecked(false);
      // Keep the review surface alive even if an older main/preload pair (or
      // an incompatible API response) omitted the failure detail. The IPC
      // schema rejects this shape in current builds, but this boundary is
      // still user-facing and must not crash while rolling upgrades settle.
      const code = result.data.failure?.code;
      setError(publicationFailureMessage(code ?? "internal"));
    } else {
      setPreview(null);
      setError(`Publication ${result.data.outcome}.`);
    }
  };
  const isExpired = expired || deadlineExpired;
  const textAreaClassName = [
    "mt-1",
    "min-h-16",
    "w-full",
    "rounded-md",
    "border",
    "border-line-input",
    "bg-transparent",
    "px-3",
    "py-2",
    "text-sm",
  ].join(" ");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          void reject();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review AgentScan publication</DialogTitle>
          <DialogDescription>
            VEX will write one public metadata file and use its permanent Publisher Key to
            publish. No browser key, source code, project scan, wallet, or execution permission
            is sent.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-4">
          <div className="rounded-lg border border-line-2 bg-surface-1 p-4 text-sm">
            <div className="vex-eyebrow mb-2">PUBLIC STRATEGY MANIFEST</div>
            <div className="font-semibold">
              {requestedVersion?.manifest.name ?? "VEX public profile"}
              {requestedVersion ? ` · ${requestedVersion.semver}` : ""}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-ink-tertiary">Manifest digest</dt>
              <dd className="truncate">
                {requestedVersion?.manifestDigest ?? "Resolved after project selection"}
              </dd>
              <dt className="text-ink-tertiary">Artifact digest</dt>
              <dd className="truncate">
                {requestedVersion?.artifactDigest ?? "Resolved after project selection"}
              </dd>
              <dt className="text-ink-tertiary">Source</dt>
              <dd>{review.sourceOrigin}</dd>
            </dl>
          </div>
          {isExpired ? (
            <div
              role="alert"
              className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
            >
              <div className="font-semibold">This AgentScan request expired</div>
              <p className="mt-1 text-xs text-ink-secondary">
                Close this review and start a new request from AgentScan. Nothing was published.
              </p>
            </div>
          ) : null}
          <label className="text-sm font-medium">
            Studio project
            <SelectMenu
              ariaLabel="Studio project"
              value={projectId}
              options={options}
              onChange={(id) => {
                ++operation.current;
                setProjectId(id);
                setPreview(null);
                setChecked(false);
                setProfileMode("idle");
                setExpired(false);
                setError(null);
                const next = available.find((item) => item.id === id);
                if (next) {
                  setProfile({
                    name: next.name,
                    summary: "",
                    semver: "1.0.0",
                    capabilities: [],
                    inputs: [],
                    outputs: [],
                  });
                }
              }}
              placeholder="Choose a project…"
              disabled={projects.isPending || options.length === 0}
              className="mt-2"
            />
          </label>
          {review.mode === "local_project" && selected && profileMode === "idle"
            ? busy
              ? <p className="text-xs text-ink-tertiary">Loading saved public profile…</p>
              : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void loadPreview(false)}
                    disabled={isExpired}
                  >
                    Use saved public profile
                  </Button>
                  <Button variant="outline" onClick={beginProfileEdit} disabled={isExpired}>
                    Create/edit public profile
                  </Button>
                </div>
              )
            : null}
          {review.mode === "local_project" && selected && profileMode === "saved" && !preview ? (
            <Button
              variant="outline"
              onClick={() => void loadPreview(false)}
              disabled={busy || isExpired}
            >
              Use saved public profile
            </Button>
          ) : null}
          {review.mode === "local_project" && selected && profileMode === "edit" ? (
            <div className="rounded-lg border border-line-2 bg-surface-1 p-4 text-sm">
              <div className="vex-eyebrow mb-2">VEX PUBLIC PROFILE</div>
              <p className="mb-3 text-xs text-ink-tertiary">
                Declare only the public, non-executable profile. VEX does not inspect this
                project’s source, roster, tools, wallets, or environment.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  Name
                  <Input
                    value={profile.name}
                    onChange={(event) => updateProfile({ name: event.target.value })}
                  />
                </label>
                <label>
                  Semver
                  <Input
                    value={profile.semver}
                    onChange={(event) => updateProfile({ semver: event.target.value })}
                  />
                </label>
              </div>
              <label className="mt-3 block">
                Summary
                <textarea
                  className={textAreaClassName}
                  value={profile.summary}
                  onChange={(event) => updateProfile({ summary: event.target.value })}
                />
              </label>
              <label className="mt-3 block">
                Capabilities <span className="text-xs text-ink-tertiary">comma separated</span>
                <Input
                  value={profile.capabilities.join(", ")}
                  onChange={(event) => updateProfile({
                    capabilities: event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })}
                />
              </label>
              <label className="mt-3 block">
                Inputs{" "}
                <span className="text-xs text-ink-tertiary">
                  one per line: name | description | required/optional
                </span>
                <textarea
                  className={textAreaClassName}
                  value={profile.inputs
                    .map(
                      (item) =>
                        `${item.name} | ${item.description} | ${
                          item.required ? "required" : "optional"
                        }`,
                    )
                    .join("\n")}
                  onChange={(event) => updateProfile({
                    inputs: parseRows(
                      event.target.value,
                      true,
                    ) as LocalAgentPublicProfileDraft["inputs"],
                  })}
                />
              </label>
              <label className="mt-3 block">
                Outputs{" "}
                <span className="text-xs text-ink-tertiary">
                  one per line: name | description
                </span>
                <textarea
                  className={textAreaClassName}
                  value={profile.outputs
                    .map((item) => `${item.name} | ${item.description}`)
                    .join("\n")}
                  onChange={(event) => updateProfile({
                    outputs: parseRows(
                      event.target.value,
                      false,
                    ) as LocalAgentPublicProfileDraft["outputs"],
                  })}
                />
              </label>
              <Button variant="outline" onClick={() => void loadPreview(true)} disabled={busy}>
                Preview exact publication
              </Button>
            </div>
          ) : null}
          {!preview && selected && review.mode !== "local_project" ? (
            <Button
              variant="outline"
              onClick={() => void loadPreview(false)}
              disabled={busy || isExpired}
            >
              Preview exact publication
            </Button>
          ) : null}
          {preview ? (
            <div className="rounded-lg border border-line-2 bg-surface-1 p-4 text-sm">
              <div className="font-semibold">
                {preview.action === "create" ? "Creates" : "Leaves unchanged"}{" "}
                {preview.relativePath}
              </div>
              <div className="mt-2 text-xs text-ink-tertiary">
                Manifest digest: {preview.manifestDigest}
                <br />
                Artifact digest: {preview.artifactDigest}
              </div>
              {preview.profileJson && profileMode === "saved" ? (
                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={beginProfileEdit}
                  disabled={busy}
                >
                  Edit loaded profile
                </Button>
              ) : null}
              {preview.profileJson ? (
                <>
                  <div className="mt-3 font-semibold">Exact VEX profile</div>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface-0 p-3 text-xs">
                    {preview.profileJson}
                  </pre>
                </>
              ) : null}
              <div className="mt-3 font-semibold">Exact public manifest</div>
              <pre
                className="mt-1 max-h-56 overflow-auto rounded bg-surface-0 p-3 text-xs"
                data-testid="agentscan-publication-json"
              >
                {preview.manifestJson}
              </pre>
              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                <span>I reviewed this exact public JSON and want VEX to publish it.</span>
              </label>
            </div>
          ) : null}
          {!isExpired ? <SubmitError submitError={error} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void reject()} disabled={busy}>
            Reject / cancel
          </Button>
          <Button
            variant="accent"
            onClick={() => void confirm()}
            disabled={!preview || !checked || busy || isExpired}
          >
            {busy ? "Working…" : "Confirm and publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
