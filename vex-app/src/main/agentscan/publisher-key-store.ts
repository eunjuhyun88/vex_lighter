import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Main-process-only persistent Publisher Key. The disk blob is always
 * Electron-safeStorage ciphertext; failure to access OS encryption is fatal. */
export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface PublisherKey {
  readonly publicKey: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
}
export class PublisherKeyStoreError extends Error {
  constructor(readonly code: "os_encryption_unavailable" | "stored_key_invalid" | "store_failed") {
    super(code);
  }
}
const rawPublicKey = (privateKey: KeyObject): Buffer => {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(der) || der.byteLength !== 44) throw new PublisherKeyStoreError("stored_key_invalid");
  return der.subarray(-32);
};
const fromPrivate = (privateDer: Uint8Array): PublisherKey => {
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey({ key: Buffer.from(privateDer), format: "der", type: "pkcs8" }); }
  catch { throw new PublisherKeyStoreError("stored_key_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new PublisherKeyStoreError("stored_key_invalid");
  const raw = rawPublicKey(privateKey);
  return {
    privateKey,
    publicKey: raw.toString("base64url"),
    // AgentScan's publisherKeyId is this raw 64-character SHA-256 hex.
    keyId: createHash("sha256").update(raw).digest("hex"),
  };
};
export function createPublisherKeyStore(input: { userDataPath: string; safeStorage: ElectronSafeStorage; fileName?: string }): { getOrCreate(): Promise<PublisherKey> } {
  const target = path.join(input.userDataPath, input.fileName ?? "agentscan-publisher-key.v1");
  let cached: PublisherKey | null = null;
  let pending: Promise<PublisherKey> | null = null;
  return { async getOrCreate() {
    if (cached !== null) return cached;
    if (pending !== null) return pending;
    const run = (async () => {
      if (!input.safeStorage.isEncryptionAvailable()) throw new PublisherKeyStoreError("os_encryption_unavailable");
      try {
        const saved = JSON.parse(input.safeStorage.decryptString(await readFile(target))) as { version?: unknown; privateKey?: unknown };
        if (saved.version !== 1 || typeof saved.privateKey !== "string") throw new PublisherKeyStoreError("stored_key_invalid");
        cached = fromPrivate(Buffer.from(saved.privateKey, "base64url"));
        return cached;
      } catch (cause: unknown) {
        if (!(typeof cause === "object" && cause !== null && "code" in cause && (cause as { code: unknown }).code === "ENOENT")) throw cause instanceof PublisherKeyStoreError ? cause : new PublisherKeyStoreError("stored_key_invalid");
      }
      const generated = generateKeyPairSync("ed25519");
      const privateDer = generated.privateKey.export({ format: "der", type: "pkcs8" });
      const next = fromPrivate(privateDer);
      const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(temp, input.safeStorage.encryptString(JSON.stringify({ version: 1, privateKey: privateDer.toString("base64url") })), { flag: "wx", mode: 0o600 });
        // A hard-link publish makes first-writer-wins explicit across
        // independent store instances; rename would silently overwrite a
        // key created by another concurrent VEX process.
        await link(temp, target);
      } catch (cause: unknown) {
        if (typeof cause === "object" && cause !== null && "code" in cause && (cause as { code: unknown }).code === "EEXIST") {
          try {
            const saved = JSON.parse(input.safeStorage.decryptString(await readFile(target))) as { version?: unknown; privateKey?: unknown };
            if (saved.version !== 1 || typeof saved.privateKey !== "string") throw new Error("invalid");
            cached = fromPrivate(Buffer.from(saved.privateKey, "base64url"));
            return cached;
          } catch { throw new PublisherKeyStoreError("stored_key_invalid"); }
        }
        await unlink(temp).catch(() => undefined);
        throw new PublisherKeyStoreError("store_failed");
      } finally {
        await unlink(temp).catch(() => undefined);
      }
      cached = next;
      return next;
    })();
    pending = run;
    try { return await run; } finally { if (pending === run) pending = null; }
  } };
}
