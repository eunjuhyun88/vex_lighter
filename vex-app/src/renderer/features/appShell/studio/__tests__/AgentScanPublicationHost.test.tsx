/**
 * The local AgentScan publication hand-off is deliberately tested at the
 * renderer boundary: choosing a project must consume its VEX-owned public
 * profile without exposing a second "use saved profile" step, while a missing
 * profile must land in the explicit editor and a stale request must be clear.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentScanPublicationHost } from "../AgentScanPublicationHost.js";
import { makeError, makeProject, installStudioDomStubs } from "./studio-fixtures.js";

const project = makeProject({ name: "atlas" });
const secondProject = makeProject({ name: "beta" });
const digest = `sha256:${"a".repeat(64)}`;
const profileJson = `${JSON.stringify({
  schema: "agentscan.vex.agent-public/1",
  semver: "1.2.3",
  manifest: {
    schemaVersion: "agentscan.strategy-manifest/1",
    name: "Atlas public agent",
    summary: "A public declaration.",
    capabilities: ["analyze"],
    inputs: [{ name: "question", description: "A question.", required: true }],
    outputs: [{ name: "answer", description: "An answer." }],
    executionEnabled: false,
    strategy: {},
  },
})}\n`;

const getPending = vi.fn();
const preview = vi.fn();
const reject = vi.fn();
const confirm = vi.fn();
const listProjects = vi.fn();
const unsubscribe = vi.fn();

function pendingReview(intentId = "aspub_test") {
  return {
    schema: "agentscan.vex.publication-review/1",
    intentId,
    state: "awaiting_review",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceOrigin: "http://localhost:3011",
    mode: "local_project",
    request: null,
  } as const;
}

function publicationPreview(targetProject = project, targetProfile = profileJson) {
  return {
    schema: "agentscan.vex.publication-preview/1",
    intentId: "aspub_test",
    previewToken: "aspv_test",
    manifestDigest: digest,
    artifactDigest: digest,
    manifestJson: `${profileJson}`,
    profileJson: targetProfile,
    relativePath: `.vex/agentscan/publications/${digest.slice(7)}.json`,
    project: { id: targetProject.id, name: targetProject.name, scopeVersion: targetProject.scopeVersion },
    action: "create",
  } as const;
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentScanPublicationHost />
    </QueryClientProvider>,
  );
}

function chooseAtlas(): void {
  fireEvent.click(screen.getByRole("combobox", { name: "Studio project" }));
  fireEvent.click(screen.getByRole("option", { name: "atlas" }));
}

beforeEach(() => {
  installStudioDomStubs();
  getPending.mockReset().mockResolvedValue({ ok: true, data: pendingReview() });
  preview.mockReset().mockResolvedValue({ ok: true, data: publicationPreview() });
  listProjects.mockReset().mockResolvedValue({ ok: true, data: [project] });
  reject.mockReset().mockResolvedValue({ ok: true, data: { outcome: "rejected" } });
  confirm.mockReset();
  unsubscribe.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      projects: { list: listProjects },
      studio: {
        agentscanPublicationGetPending: getPending,
        agentscanPublicationPreview: preview,
        agentscanPublicationReject: reject,
        agentscanPublicationConfirm: confirm,
        onAgentscanPublicationIntent: vi.fn().mockReturnValue(unsubscribe),
      },
    },
  });
});

afterEach(() => cleanup());

describe("AgentScan local publication review", () => {
  it("loads the canonical public profile and exact preview after project selection", async () => {
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();

    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledWith({
      intentId: "aspub_test",
      projectId: project.id,
      expectedScopeVersion: project.scopeVersion,
    });
    expect(screen.getByText("Exact VEX profile")).not.toBeNull();
    expect(screen.getByTestId("agentscan-publication-json").textContent).toContain(profileJson.trim());
    expect(screen.queryByRole("button", { name: "Use saved public profile" })).toBeNull();
  });

  it("opens the safe editor when the project has no public profile", async () => {
    preview.mockResolvedValueOnce({
      ok: false,
      error: makeError("This project has no VEX public profile. Complete the public profile form and preview again."),
    });
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();

    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("atlas");
    expect(screen.getByText(/VEX does not inspect this project’s source/)).not.toBeNull();
  });

  it("turns a stale review into an explicit expired state", async () => {
    preview.mockResolvedValueOnce({
      ok: false,
      error: makeError("The local publication intent is no longer pending."),
    });
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();

    expect((await screen.findByRole("alert")).textContent).toContain("This AgentScan request expired");
    expect(screen.queryByText("The local publication intent is no longer pending.")).toBeNull();
  });

  it("does not let a late preview overwrite a newer project selection", async () => {
    listProjects.mockResolvedValueOnce({ ok: true, data: [project, secondProject] });
    let resolveFirst: ((result: unknown) => void) | undefined;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    preview.mockReset()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ok: true, data: publicationPreview(secondProject, "beta profile") });
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();
    fireEvent.click(screen.getByRole("combobox", { name: "Studio project" }));
    fireEvent.click(screen.getByRole("option", { name: "beta" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    resolveFirst?.({ ok: true, data: publicationPreview(project, "stale profile") });
    await waitFor(() => expect(screen.getAllByText("beta profile").length).toBeGreaterThanOrEqual(1));
    expect(screen.queryAllByText("stale profile").length).toBe(0);
  });

  it("clears busy when the preview preload call throws", async () => {
    preview.mockRejectedValueOnce(new Error("bridge unavailable"));
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();
    const retry = await screen.findByRole("button", { name: "Use saved public profile" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a safe recovery action when AgentScan authorization is stale", async () => {
    confirm.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "failed", failure: { code: "unauthorized" } },
    });
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();
    await screen.findByTestId("agentscan-publication-json");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and publish" }));

    expect(await screen.findByText(/no longer authorized with AgentScan/i)).not.toBeNull();
    expect(screen.queryByText("Publication failed.")).toBeNull();
  });

  it("does not crash when a legacy failed result omits failure details", async () => {
    confirm.mockResolvedValueOnce({ ok: true, data: { outcome: "failed" } });
    renderHost();
    await screen.findByRole("combobox", { name: "Studio project" });
    chooseAtlas();
    await screen.findByTestId("agentscan-publication-json");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and publish" }));

    expect(await screen.findByText(/could not complete this publication/i)).not.toBeNull();
  });
});
