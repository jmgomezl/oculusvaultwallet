import type { Storage } from "./Storage.js";

/** Minimal shape of the Telegram WebApp CloudStorage API we rely on. */
interface TelegramCloudStorageApi {
  setItem(
    key: string,
    value: string,
    cb?: (err: string | null, ok?: boolean) => void,
  ): void;
  getItem(key: string, cb: (err: string | null, value?: string) => void): void;
  removeItem(
    key: string,
    cb?: (err: string | null, ok?: boolean) => void,
  ): void;
}

/**
 * Storage backed by Telegram's per-user CloudStorage. The encrypted record
 * follows the user across devices but is useless without the user secret,
 * preserving non-custody. Note Telegram's per-value limit (~4 KB) — our
 * record fits comfortably.
 */
export class TelegramCloudStorage implements Storage {
  constructor(private readonly api: TelegramCloudStorageApi) {}

  /** Build from window.Telegram.WebApp.CloudStorage; throws if unavailable. */
  static fromWindow(): TelegramCloudStorage {
    const tg = (globalThis as any)?.Telegram?.WebApp?.CloudStorage;
    if (!tg) {
      throw new Error(
        "Telegram CloudStorage is not available (open this inside a Telegram Mini App)",
      );
    }
    return new TelegramCloudStorage(tg);
  }

  getItem(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.api.getItem(key, (err, value) => {
        if (err) reject(new Error(err));
        else resolve(value && value.length > 0 ? value : null);
      });
    });
  }

  setItem(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.api.setItem(key, value, (err) => {
        if (err) reject(new Error(err));
        else resolve();
      });
    });
  }

  removeItem(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.api.removeItem(key, (err) => {
        if (err) reject(new Error(err));
        else resolve();
      });
    });
  }
}
