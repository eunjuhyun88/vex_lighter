import { describe, expect, it } from "vitest";
import {
  healthMatchesRuntime,
  parsePublicRuntimeDeclaration,
  PUBLIC_RUNTIME_BUNDLE_DIGEST,
  publicRuntimeBundleDigest,
  publicRuntimeEndpoints,
} from "../public-runtime.js";

const declaration = {
  schemaVersion: "agentscan.runtime-bundle/1",
  bundleVersion: "candidate",
  strategy: "portfolio_change_summary",
  node: { major: 24, module: "esm" },
  api: { health: "api/health.js", manifest: "api/manifest.js", run: "api/run.js" },
  core: { entrypoint: "lib/core.js", networkAccess: false, permissions: ["aggregate_inputs_only", "no_addresses"] },
  files: [{ path: "api/run.js", sha256: "a".repeat(64) }],
} as const;

describe("public runtime guard", () => {
  it("pins the audited Node 24 declaration digest", () => {
    expect(PUBLIC_RUNTIME_BUNDLE_DIGEST).toBe("sha256:2e494176e0d89de2a2b27e3c900c44380330e707e759c40d8446f3b90f7534f7");
  });
  it("derives a canonical declaration digest and only exposes fixed API paths", () => {
    const parsed = parsePublicRuntimeDeclaration(declaration);
    if (parsed === null) throw new Error("declaration was rejected");
    const digest = publicRuntimeBundleDigest(parsed);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(publicRuntimeEndpoints("https://portfolio-runtime.vercel.app/")).toEqual({
      endpoint: "https://portfolio-runtime.vercel.app/api/run",
      healthEndpoint: "https://portfolio-runtime.vercel.app/api/health",
    });
    expect(publicRuntimeEndpoints("https://example.com/")).toBeNull();
  });

  it("requires a matching health status, version, and declaration digest", () => {
    const parsed = parsePublicRuntimeDeclaration(declaration);
    if (parsed === null) throw new Error("declaration was rejected");
    const expected = { bundleVersion: parsed.bundleVersion, runtimeBundleDigest: publicRuntimeBundleDigest(parsed) };
    expect(healthMatchesRuntime({ status: "ok", strategy: "portfolio_change_summary", version: expected.bundleVersion, runtimeBundleDigest: expected.runtimeBundleDigest, requestId: "request" }, expected)).toBe(true);
    expect(healthMatchesRuntime({ status: "ok", strategy: "portfolio_change_summary", version: "other", runtimeBundleDigest: expected.runtimeBundleDigest, requestId: "request" }, expected)).toBe(false);
  });
});
