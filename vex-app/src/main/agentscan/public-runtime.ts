import { createHash } from "node:crypto";
import { stableStringify } from "./stable-json.js";

export interface PublicRuntimeDeclaration {
  readonly schemaVersion: "agentscan.runtime-bundle/1";
  readonly bundleVersion: string;
  readonly strategy: "portfolio_change_summary";
  readonly node: { readonly major: number; readonly module: "esm" };
  readonly api: { readonly health: "api/health.js"; readonly manifest: "api/manifest.js"; readonly run: "api/run.js" };
  readonly core: { readonly entrypoint: "lib/core.js"; readonly networkAccess: false; readonly permissions: readonly string[] };
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

function isDigestHex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

/** Validate the public bundle declaration before VEX derives a trusted digest. */
export function parsePublicRuntimeDeclaration(value: unknown): PublicRuntimeDeclaration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const declaration = value as Record<string, unknown>;
  const api = declaration.api;
  const core = declaration.core;
  const node = declaration.node;
  const files = declaration.files;
  if (
    declaration.schemaVersion !== "agentscan.runtime-bundle/1"
    || typeof declaration.bundleVersion !== "string" || declaration.bundleVersion.length === 0 || declaration.bundleVersion.length > 32
    || declaration.strategy !== "portfolio_change_summary"
    || typeof api !== "object" || api === null || Array.isArray(api)
    || typeof core !== "object" || core === null || Array.isArray(core)
    || typeof node !== "object" || node === null || Array.isArray(node)
    || !Array.isArray(files) || files.length === 0 || files.length > 32
  ) return null;
  const apiRecord = api as Record<string, unknown>;
  const coreRecord = core as Record<string, unknown>;
  const nodeRecord = node as Record<string, unknown>;
  if (
    apiRecord.health !== "api/health.js" || apiRecord.manifest !== "api/manifest.js" || apiRecord.run !== "api/run.js"
    || coreRecord.entrypoint !== "lib/core.js" || coreRecord.networkAccess !== false || !Array.isArray(coreRecord.permissions)
    || nodeRecord.major !== 24 || nodeRecord.module !== "esm"
    || !coreRecord.permissions.every((permission) => typeof permission === "string")
    || !files.every((file) => typeof file === "object" && file !== null && !Array.isArray(file)
      && typeof (file as Record<string, unknown>).path === "string" && isDigestHex((file as Record<string, unknown>).sha256))
  ) return null;
  return declaration as unknown as PublicRuntimeDeclaration;
}

export function publicRuntimeBundleDigest(declaration: PublicRuntimeDeclaration): string {
  return `sha256:${createHash("sha256").update(stableStringify(declaration), "utf8").digest("hex")}`;
}

export function publicRuntimeEndpoints(origin: string): { readonly endpoint: string; readonly healthEndpoint: string } | null {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== ""
      || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/u.test(url.hostname)
      || url.href !== origin
    ) return null;
    return { endpoint: new URL("/api/run", url).toString(), healthEndpoint: new URL("/api/health", url).toString() };
  } catch {
    return null;
  }
}

export function healthMatchesRuntime(value: unknown, expected: { readonly bundleVersion: string; readonly runtimeBundleDigest: string }): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return health.status === "ok"
    && health.strategy === "portfolio_change_summary"
    && health.version === expected.bundleVersion
    && health.runtimeBundleDigest === expected.runtimeBundleDigest
    && typeof health.requestId === "string"
    && health.requestId.length > 0
    && health.requestId.length <= 256;
}

/** Final, audited v1.1.2 declaration from the public runtime repository. */
const finalDeclaration = {
  api: { health: "api/health.js", manifest: "api/manifest.js", run: "api/run.js" },
  bundleVersion: "1.1.2",
  core: {
    entrypoint: "lib/core.js",
    networkAccess: false,
    permissions: ["aggregate_inputs_only", "no_addresses", "no_filesystem", "no_network", "no_secrets", "no_trading"],
  },
  files: [
    { path: "api/health.js", sha256: "68398c045a6664c40583c255dcdd4e9f27216fc3a5cbc93c5d9b60bc1b3760d5" },
    { path: "api/manifest.js", sha256: "95336a7ff0fdbcbb375476c58dd3390c91c7ac5a2bc0c1e7c807f82e261edec0" },
    { path: "api/run.js", sha256: "55f91e6518e6d9935daea311c0a7da9aee6502f45036f1c25757ae2cf8366934" },
    { path: "lib/bundle.js", sha256: "705f057173fe115ee5c28fb4ee60aa41c4a1fa11c4cbfa9b5c5856781486caa4" },
    { path: "lib/canonical.js", sha256: "4183f3a5d8c07952fb1dd0cd6a45c506e95f3de0aa15a7dbc9e9465e300de840" },
    { path: "lib/core.js", sha256: "bca36a81c9b580801218c54531c2d94cebbd72262fb230f8cd75ac71cee405d9" },
    { path: "lib/http.js", sha256: "2cd776c18403f4ce0c86a3bb079ab7bc4654beae1ae0940669f76f46a1febc30" },
  ],
  node: { major: 24, module: "esm" },
  schemaVersion: "agentscan.runtime-bundle/1",
  strategy: "portfolio_change_summary",
} as const;

export const PUBLIC_RUNTIME_BUNDLE_DECLARATION = parsePublicRuntimeDeclaration(finalDeclaration)!;
if (PUBLIC_RUNTIME_BUNDLE_DECLARATION === null) throw new Error("public_runtime_declaration_invalid");
export const PUBLIC_RUNTIME_BUNDLE_DIGEST = publicRuntimeBundleDigest(PUBLIC_RUNTIME_BUNDLE_DECLARATION);
const FINAL_DIGEST = "sha256:2e494176e0d89de2a2b27e3c900c44380330e707e759c40d8446f3b90f7534f7";
if (PUBLIC_RUNTIME_BUNDLE_DIGEST !== FINAL_DIGEST) throw new Error("public_runtime_digest_drift");
