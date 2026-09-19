import { spawn } from "node:child_process";
import { normalizeDevEnvironment } from "./dev-electron-config.mjs";

const child = spawn("vite", ["--config", "vite.renderer.config.ts"], {
  stdio: "inherit",
  env: normalizeDevEnvironment(),
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
