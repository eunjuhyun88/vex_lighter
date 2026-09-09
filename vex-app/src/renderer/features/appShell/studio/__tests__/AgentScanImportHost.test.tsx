import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentScanImportReview } from "@shared/schemas/agentscan-import.js";

const projects = [{ id: "11111111-1111-4111-8111-111111111111", name: "Wallet Ops", scopeVersion: 2 }];
const pending = vi.fn();
const preview = vi.fn();
const confirm = vi.fn();
const reject = vi.fn();
const setRuntimeMode = vi.fn();
const setActiveProjectId = vi.fn();
let intentListener: (() => void) | null = null;
const subscribe = vi.fn((cb: () => void) => {
  intentListener = cb;
  return () => undefined;
});
vi.mock("../../../../lib/api/projects.js", () => ({ useProjects: () => ({ data: { ok: true, data: projects }, isPending: false }) }));
vi.mock("../../../../stores/uiStore.js", () => ({
  useUiStore: (selector: (s: Record<string, unknown>) => unknown) => selector({
    setRuntimeMode,
    setActiveProjectId,
  }),
}));
const { AgentScanImportHost } = await import("../AgentScanImportHost.js");

const review: AgentScanImportReview = {
  schema: "agentscan.vex.import-review/1", intentId: "intent-1", state: "awaiting_review",
  expiresAt: new Date(Date.now() + 60_000).toISOString(), sourceOrigin: "agentscan.example",
  manifestDigest: "sha256:abc", manifest: { schema: "agentscan.agent-version/1", agentVersionId: "av-1", productId: "product-1", name: "Watch Agent", version: "1.0.0", creator: "Vex", summary: "Watches markets", category: "monitoring", chain: "ethereum", signingMode: "none", artifactAvailability: "catalog_reference_only", executionEnabled: false },
};

beforeEach(() => {
  pending.mockReset();
  preview.mockReset();
  confirm.mockReset();
  reject.mockReset();
  subscribe.mockClear();
  setRuntimeMode.mockClear();
  setActiveProjectId.mockClear();
  intentListener = null;
  pending.mockResolvedValue({ ok: true, data: review });
  preview.mockResolvedValue({ ok: true, data: { schema: "agentscan.vex.import-preview/1", intentId: "intent-1", previewToken: "token", agentVersionId: "av-1", manifestDigest: "sha256:abc", project: projects[0], change: { action: "create", relativePath: "agent.manifest.json", walletAccess: false, signing: false, execution: false } } });
  confirm.mockResolvedValue({ ok: true, data: { outcome: "approved", receipt: {} } });
  reject.mockResolvedValue({ ok: true, data: { outcome: "rejected" } });
  Object.defineProperty(window, "vex", { configurable: true, value: { studio: { agentscanImportGetPending: pending, agentscanImportPreview: preview, agentscanImportConfirm: confirm, agentscanImportReject: reject, onAgentscanImportIntent: subscribe } } });
});

function renderHost(): void {
  render(<QueryClientProvider client={new QueryClient()}><AgentScanImportHost /></QueryClientProvider>);
}

describe("AgentScanImportHost", () => {
  it("previews and confirms only after explicit acknowledgement", async () => {
    renderHost();
    await screen.findByText("Watch Agent · 1.0.0");
    fireEvent.click(screen.getByRole("combobox", { name: "Studio project" }));
    fireEvent.click(screen.getByRole("option", { name: "Wallet Ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByText(/Creates agent\.manifest/);
    expect((screen.getByRole("button", { name: "Confirm import" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ previewToken: "token" })));
  });

  it("rejects when the user cancels", async () => {
    renderHost();
    await screen.findByText("Watch Agent · 1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Reject / cancel" }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith({ intentId: "intent-1" }));
  });

  it("shows an expired request and does not preview", async () => {
    pending.mockResolvedValue({ ok: true, data: { ...review, expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    renderHost();
    expect(await screen.findByTestId("agentscan-import-expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview changes" })).toBeNull();
  });

  it("shows a preview Result failure", async () => {
    preview.mockResolvedValue({ ok: false, error: { message: "Preview unavailable" } });
    renderHost();
    await screen.findByText("Watch Agent · 1.0.0");
    fireEvent.click(screen.getByRole("combobox", { name: "Studio project" }));
    fireEvent.click(screen.getByRole("option", { name: "Wallet Ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByText("Preview unavailable")).toBeTruthy();
  });

  it("clears a stale preview and asks for review again", async () => {
    confirm.mockResolvedValue({ ok: true, data: { outcome: "preview_stale" } });
    renderHost();
    await screen.findByText("Watch Agent · 1.0.0");
    fireEvent.click(screen.getByRole("combobox", { name: "Studio project" }));
    fireEvent.click(screen.getByRole("option", { name: "Wallet Ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByText(/Creates agent\.manifest/);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(await screen.findByText("This preview is stale. Review the changes again.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("labels an origin update and keeps the explicit confirmation gate", async () => {
    preview.mockResolvedValue({ ok: true, data: {
      schema: "agentscan.vex.import-preview/1", intentId: "intent-1", previewToken: "token",
      agentVersionId: "av-1", manifestDigest: "sha256:abc", project: projects[0],
      change: { action: "update_origin", previousSourceOrigin: "old.agentscan.example", relativePath: "agent.manifest.json", walletAccess: false, signing: false, execution: false },
    } });
    renderHost();
    await screen.findByText("Watch Agent · 1.0.0");
    fireEvent.click(screen.getByRole("combobox", { name: "Studio project" }));
    fireEvent.click(screen.getByRole("option", { name: "Wallet Ops" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect((await screen.findByTestId("agentscan-import-origin-change")).textContent).toContain("old.agentscan.example → agentscan.example");
    expect((screen.getByRole("button", { name: "Confirm import" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not close a newer intent when an older reject resolves", async () => {
    let resolveReject: ((value: unknown) => void) | null = null;
    reject.mockReturnValue(new Promise((resolve) => { resolveReject = resolve; }));
    const second = { ...review, intentId: "intent-2", manifest: { ...review.manifest, name: "Second Agent" } };
    pending.mockResolvedValueOnce({ ok: true, data: review }).mockResolvedValueOnce({ ok: true, data: second });
    renderHost();
    await screen.findByText("Watch Agent · 1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Reject / cancel" }));
    await waitFor(() => expect(reject).toHaveBeenCalled());
    intentListener?.();
    await screen.findByText("Second Agent · 1.0.0");
    (resolveReject as ((value: unknown) => void) | null)?.({
      ok: true,
      data: { outcome: "rejected" },
    });
    expect(await screen.findByText("Second Agent · 1.0.0")).toBeTruthy();
  });

  it("ignores an older pending result after a newer import event", async () => {
    let resolveInitial: ((value: unknown) => void) | null = null;
    const fresh = {
      ...review,
      intentId: "intent-2",
      manifest: { ...review.manifest, name: "Fresh Agent" },
    };
    pending
      .mockReturnValueOnce(new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ ok: true, data: fresh });

    renderHost();
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    intentListener?.();
    await screen.findByText("Fresh Agent · 1.0.0");

    (resolveInitial as ((value: unknown) => void) | null)?.({ ok: true, data: null });
    await waitFor(() => {
      expect(screen.getByText("Fresh Agent · 1.0.0")).toBeTruthy();
    });
  });
});
