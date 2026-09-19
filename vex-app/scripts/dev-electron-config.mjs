import path from "node:path";
import { homedir } from "node:os";

const defaults = {
  VEX_CONFIG_DIR:
    process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "vex-dev")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support", "vex-dev")
        : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "vex-dev"),
  VEX_RENDERER_PORT: "5274",
  VEX_PG_PORT: "28532",
  VEX_EMBED_PORT: "28234",
  VEX_AGENTSCAN_BRIDGE_PORT: "48832",
};

function validPort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return port >= 1 && port <= 65535 ? String(port) : null;
}

export function normalizeDevEnvironment(env = process.env) {
  return {
    ...env,
    VEX_CONFIG_DIR: env.VEX_CONFIG_DIR || defaults.VEX_CONFIG_DIR,
    VEX_RENDERER_PORT: validPort(env.VEX_RENDERER_PORT) ?? defaults.VEX_RENDERER_PORT,
    VEX_PG_PORT: validPort(env.VEX_PG_PORT) ?? defaults.VEX_PG_PORT,
    VEX_EMBED_PORT: validPort(env.VEX_EMBED_PORT) ?? defaults.VEX_EMBED_PORT,
    VEX_AGENTSCAN_BRIDGE_PORT: validPort(env.VEX_AGENTSCAN_BRIDGE_PORT) ?? defaults.VEX_AGENTSCAN_BRIDGE_PORT,
  };
}
