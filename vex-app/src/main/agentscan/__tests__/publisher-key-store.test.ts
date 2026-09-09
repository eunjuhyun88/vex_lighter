import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPublisherKeyStore } from "../publisher-key-store.js";

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/u, ""),
};
describe("publisher key store", () => {
  it("is stable across store instances and persists ciphertext only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-publisher-"));
    const one = await createPublisherKeyStore({ userDataPath: root, safeStorage: storage }).getOrCreate();
    const two = await createPublisherKeyStore({ userDataPath: root, safeStorage: storage }).getOrCreate();
    expect(one.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(one.keyId).toMatch(/^[a-f0-9]{64}$/u);
    expect(two.keyId).toBe(one.keyId);
    expect(await readFile(path.join(root, "agentscan-publisher-key.v1"), "utf8")).toMatch(/^encrypted:/u);
  });
  it("fails closed without OS encryption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-publisher-"));
    await expect(createPublisherKeyStore({ userDataPath: root, safeStorage: { ...storage, isEncryptionAvailable: () => false } }).getOrCreate()).rejects.toMatchObject({ code: "os_encryption_unavailable" });
  });
  it("shares one creation promise for concurrent first access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-publisher-"));
    let encryptions = 0;
    const concurrentStorage = { ...storage, encryptString: (value: string) => { encryptions += 1; return storage.encryptString(value); } };
    const store = createPublisherKeyStore({ userDataPath: root, safeStorage: concurrentStorage });
    const [one, two] = await Promise.all([store.getOrCreate(), store.getOrCreate()]);
    expect(one.keyId).toBe(two.keyId);
    expect(encryptions).toBe(1);
  });
  it("keeps first-writer ownership across independent store instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-publisher-"));
    const oneStore = createPublisherKeyStore({ userDataPath: root, safeStorage: storage });
    const twoStore = createPublisherKeyStore({ userDataPath: root, safeStorage: storage });
    const [one, two] = await Promise.all([oneStore.getOrCreate(), twoStore.getOrCreate()]);
    expect(two.keyId).toBe(one.keyId);
    expect((await createPublisherKeyStore({ userDataPath: root, safeStorage: storage }).getOrCreate()).keyId).toBe(one.keyId);
  });
});
