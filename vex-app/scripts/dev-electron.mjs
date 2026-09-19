import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import electron from "electron";
import { normalizeDevEnvironment } from "./dev-electron-config.mjs";

const env = normalizeDevEnvironment();
const rendererUrl = `http://127.0.0.1:${env.VEX_RENDERER_PORT}/`;
const requiredFiles = ["dist/main/index.js", "dist/preload/index.cjs", "dist/pty-host/index.js"];
const deadline = Date.now() + 60_000;

async function waitForReady() {
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      await Promise.all(requiredFiles.map((file) => access(file)));
      const response = await fetch(rendererUrl);
      if (response.ok) return;
      lastError = `renderer returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`dev Electron prerequisites were not ready within 60s: ${lastError}`);
}

await waitForReady();
const child = spawn(electron, ["."], { stdio: "inherit", env });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
