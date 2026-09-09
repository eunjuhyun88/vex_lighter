/** Own the AgentScan loopback bridge for the full app lifetime. */

import { log } from "../logger/index.js";
import {
  isSecretSessionUnlocked,
  onSecretSessionLifecycle,
} from "../secrets/session.js";
import {
  onStudioReadinessChange,
  studioReadiness,
} from "../studio/readiness.js";
import {
  agentscanAllowedOrigins,
  createAgentscanLocalBridge,
} from "./local-readonly-bridge.js";
import { getAgentscanImportIntentRegistry } from "../ipc/agentscan-import.js";
import { getAgentscanPublicationIntentRegistry } from "../ipc/agentscan-publication.js";

export function setupAgentscanLocalReadonlyBridge(
  includeDevelopmentOrigins: boolean,
): () => Promise<void> {
  const isAvailable = (): boolean =>
    isSecretSessionUnlocked() && studioReadiness().ready;
  const bridge = createAgentscanLocalBridge({
    allowedOrigins: agentscanAllowedOrigins(includeDevelopmentOrigins),
    isAvailable,
    importIntents: getAgentscanImportIntentRegistry(),
    publicationIntents: getAgentscanPublicationIntentRegistry(),
    logInfo: (message) => log.info(message),
    logWarn: (message) => log.warn(message),
  });

  let disposed = false;
  let retryDelayMs = 1_000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const reconcile = async (): Promise<void> => {
    if (disposed) return;
    const result = await bridge.start();
    if (disposed) {
      await bridge.stop();
      return;
    }
    if (result.started) {
      clearRetry();
      retryDelayMs = 1_000;
      return;
    }
    if (result.reason !== "bind_failed" || retryTimer !== null) return;

    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void reconcile();
    }, delay);
    retryTimer.unref();
  };

  const sync = (): void => {
    bridge.rotateCapabilityToken();
  };

  const unsubscribe = onSecretSessionLifecycle(sync);
  const unsubscribeReadiness = onStudioReadinessChange(sync);
  sync();
  void reconcile();

  return async () => {
    disposed = true;
    clearRetry();
    unsubscribe();
    unsubscribeReadiness();
    await bridge.stop();
  };
}
