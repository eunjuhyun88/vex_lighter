# Vex Platform and Security Audit

Date: 2026-09-19  
Branch: `integration/vex-foundation-all-local-20260919`  
Commit reviewed: `90422bfe587b4051ff7c86a3d72abfae19bb2af8`

## Scope

This review covered the Electron host, preload and renderer boundary, IPC sender validation, external navigation, local AgentScan bridge, terminal and subprocess execution, Docker and database listeners, secret storage, wallet and Lighter approval boundaries, Windows and macOS packaging, dependency policy, CI coverage, and focused regression suites.

No live wallet, exchange, leverage, or order operation was executed.

## Verified controls

- Main windows use sandboxing, context isolation, disabled Node integration, web security, and disabled insecure content.
- Navigation and `window.open` are denied unless the destination is in the explicit HTTPS allowlist.
- IPC handlers reject untrusted origins and subframes before doing work.
- The AgentScan bridge binds to loopback, checks the exact Host and Origin, requires its connector header, and rotates a per-session capability token.
- API/provider secrets use the encrypted local vault. Secret values are not intentionally written to the provider `.env` file.
- Docker subprocesses strip managed secrets from child environments, use argument arrays, cap output, and have cancellation paths.
- Focused security suites passed: 15 files, 313 tests.
- Focused Lighter and approval suites passed: 5 files, 91 tests.
- Root TypeScript build passed.
- Vex app TypeScript and process-boundary checks passed.

## Findings

### Release blocker: unsigned artifacts are not public-release safe

The default `electron-builder.yml` is explicitly an internal unsigned profile. It sets `forceCodeSigning: false`, disables Windows update signature verification, and does not notarize macOS artifacts. These files must not be distributed as public releases.

The separate `electron-builder.release.yml` enables signing, macOS notarization, and Windows update signature verification. CI must use that profile and must fail when credentials are missing.

### Local privilege boundary: database password file

The Docker/Postgres password file is plaintext on disk. macOS POSIX permissions and Windows per-user ACL inheritance reduce exposure to other unprivileged users, but a local administrator or malware running as the logged-in user can read it. This is a local compromise concern, not an unauthenticated network exploit.

### Dependency advisories

Raw `pnpm audit --prod` reports one high advisory for `bigint-buffer` and two moderate advisories for transitive `uuid` and `stream-json`. The repository's production audit gate has reviewed exceptions with reachability verifiers, and after a frozen install the custom audit passed. The exceptions must be revisited when Solana/Jayson dependency paths change.

### Test gate failure: deleted renderer test is not allowlisted

`pnpm run test:unsafe-escapes` fails because `vex-app/src/renderer/features/appShell/lighterTrading/__tests__/LighterTradingDialog.test.tsx` was removed without a matching reviewed entry in `scripts/deleted-test-allowlist.mjs`. This is a CI hygiene failure and should be fixed before merge.

### Full test runs require configured integration services

The broad root and app suites emit failures or remain incomplete when embedding configuration and external service fixtures are absent. The focused security, Lighter, approval, TypeScript, and boundary suites passed, but a local run without the required services is not evidence that the complete CI matrix passes.

## Platform assessment

Windows development previously had two confirmed portability defects: POSIX `${VAR:-default}` shell syntax and a macOS-only default config path. Both were fixed in commit `90422bfe5`. The dev bridge port environment variable is now wired to the actual listener.

The repository contains dedicated Windows and macOS CI jobs. This audit was performed on macOS; it does not replace a successful run of those hosted jobs or a signed installer smoke test on each operating system.

## Release decision

The code is suitable for continued development and focused testing. It is not ready to be called a public secure release until the signed release profile, deleted-test allowlist failure, and full CI matrix are green.
