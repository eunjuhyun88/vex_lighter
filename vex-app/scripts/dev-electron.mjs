import { spawn } from "node:child_process";
import electron from "electron";
import { normalizeDevEnvironment } from "./dev-electron-config.mjs";

const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: normalizeDevEnvironment(),
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
