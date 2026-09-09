import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { realProjectDirectory } from "../../studio/files/node-path.js";

describe("AgentScan project confinement", () => {
  it("accepts a real project directory and refuses a symlinked project root", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "vex-agentscan-paths-")));
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "vex-agentscan-outside-")));
    const project = path.join(parent, "real-project");
    const linked = path.join(parent, "linked-project");
    await mkdir(project);
    await symlink(outside, linked, "dir");
    try {
      expect(await realProjectDirectory(parent, project)).toEqual({ ok: true, directory: project });
      expect(await realProjectDirectory(parent, linked)).toEqual({ ok: false, reason: "outside_project" });
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
