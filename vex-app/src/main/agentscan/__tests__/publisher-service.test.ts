import { describe, expect, it, vi } from "vitest";
import type { PublicationRequest } from "@shared/schemas/agentscan-publication.js";

const electron = vi.hoisted(() => ({
  getPath: vi.fn(() => "/tmp/vex-test-user-data"),
}));

vi.mock("electron", () => ({
  app: { getPath: electron.getPath },
  safeStorage: {},
}));

import { completeManifestOnlyPublication } from "../publisher-service.js";

const invalidRequest = {} as PublicationRequest;
const manifestCheckRequest = { version: { manifest: {} } } as PublicationRequest;

describe("completeManifestOnlyPublication identity context", () => {
  it("does not resolve Electron userData before bootstrap remaps it", () => {
    expect(electron.getPath).not.toHaveBeenCalled();
  });

  it("rejects an expected publisher key without local receipt context", async () => {
    await expect(completeManifestOnlyPublication(invalidRequest, "expected-key"))
      .rejects.toThrow("local_receipt_context_invalid");
  });

  it("allows initial local publication context without an expected publisher key", async () => {
    await expect(completeManifestOnlyPublication(manifestCheckRequest, undefined, {
      localIntentId: "local-intent",
      profileRevisionDigest: "sha256:profile",
    })).rejects.toThrow("publication_manifest_refused");
  });
});
