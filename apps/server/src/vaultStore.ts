import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Persistent store for encrypted wallet records, keyed by the canonical
 * Telegram user id. Holds ONLY ciphertext (the client-side EncryptedWallet
 * record JSON) — the server cannot decrypt anything here.
 *
 * Backed by a single JSON file with atomic write-through (temp + rename). The
 * server runs as one process (pm2 fork), so an in-memory map flushed on every
 * mutation is sufficient and keeps the deploy as a dependency-free bundle.
 */
export interface VaultEntry {
  /** The opaque encrypted record (JSON string of EncryptedWalletRecord). */
  record: string;
  updatedAt: string;
}

export class VaultStore {
  private readonly file: string;
  private readonly map: Map<string, VaultEntry>;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "vault.json");
    this.map = new Map();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<
        string,
        VaultEntry
      >;
      for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
    } catch {
      console.warn("⚠️  vault.json unreadable — starting empty");
    }
  }

  private flush(): void {
    const obj: Record<string, VaultEntry> = {};
    for (const [k, v] of this.map.entries()) obj[k] = v;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, this.file); // atomic on same filesystem
  }

  get(uid: string): VaultEntry | null {
    return this.map.get(uid) ?? null;
  }

  put(uid: string, record: string, now: string): void {
    this.map.set(uid, { record, updatedAt: now });
    this.flush();
  }

  delete(uid: string): boolean {
    const had = this.map.delete(uid);
    if (had) this.flush();
    return had;
  }
}
