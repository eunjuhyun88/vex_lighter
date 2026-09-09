import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unlocked: true,
  ready: true,
  lifecycle: undefined as ((state: "unlocked" | "locked") => void) | undefined,
  readinessChange: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
  unsubscribeReadiness: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  rotateCapabilityToken: vi.fn(),
}));

vi.mock("../../secrets/session.js", () => ({
  isSecretSessionUnlocked: () => mocks.unlocked,
  onSecretSessionLifecycle: (listener: (state: "unlocked" | "locked") => void) => {
    mocks.lifecycle = listener;
    return mocks.unsubscribe;
  },
}));

vi.mock("../../studio/readiness.js", () => ({
  studioReadiness: () => ({ ready: mocks.ready }),
  onStudioReadinessChange: (listener: () => void) => {
    mocks.readinessChange = listener;
    return mocks.unsubscribeReadiness;
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../local-readonly-bridge.js", () => ({
  agentscanAllowedOrigins: () => new Set<string>(),
  createAgentscanLocalBridge: () => ({
    start: mocks.start,
    stop: mocks.stop,
    rotateCapabilityToken: mocks.rotateCapabilityToken,
    port: () => null,
  }),
}));

import { setupAgentscanLocalReadonlyBridge } from "../local-readonly-owner.js";

describe("AgentScan local bridge owner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.unlocked = true;
    mocks.ready = true;
    mocks.lifecycle = undefined;
    mocks.readinessChange = undefined;
    mocks.unsubscribe.mockReset();
    mocks.unsubscribeReadiness.mockReset();
    mocks.start.mockReset();
    mocks.stop.mockReset();
    mocks.rotateCapabilityToken.mockReset();
    mocks.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient bind failure while Vex remains available", async () => {
    mocks.start
      .mockResolvedValueOnce({ started: false, port: null, reason: "bind_failed" })
      .mockResolvedValueOnce({ started: true, port: 47_831 });

    const teardown = setupAgentscanLocalReadonlyBridge(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.start).toHaveBeenCalledTimes(2);

    await teardown();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeReadiness).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalled();
  });

  it("binds while Studio is unavailable so requests receive typed refusals", async () => {
    mocks.ready = false;
    mocks.start.mockResolvedValue({ started: true, port: 47_831 });

    const teardown = setupAgentscanLocalReadonlyBridge(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.rotateCapabilityToken).toHaveBeenCalledOnce();

    mocks.ready = true;
    mocks.readinessChange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.rotateCapabilityToken).toHaveBeenCalledTimes(2);

    await teardown();
  });

  it("keeps retrying a failed bind across lock and rotates tokens on transitions", async () => {
    mocks.start
      .mockResolvedValueOnce({ started: false, port: null, reason: "bind_failed" })
      .mockResolvedValueOnce({ started: true, port: 47_831 });

    const teardown = setupAgentscanLocalReadonlyBridge(false);
    await vi.advanceTimersByTimeAsync(0);
    mocks.unlocked = false;
    mocks.lifecycle?.("locked");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.start).toHaveBeenCalledTimes(2);

    mocks.unlocked = true;
    mocks.lifecycle?.("unlocked");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.rotateCapabilityToken).toHaveBeenCalledTimes(3);

    await teardown();
  });

  it("does not retry after teardown", async () => {
    mocks.start.mockResolvedValue({ started: false, port: null, reason: "bind_failed" });

    const teardown = setupAgentscanLocalReadonlyBridge(false);
    await vi.advanceTimersByTimeAsync(0);
    await teardown();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
