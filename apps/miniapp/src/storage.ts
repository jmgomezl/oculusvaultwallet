import {
  TelegramCloudStorage,
  isInsideTelegram,
  type Storage,
} from "@oculusvault/sdk";

/** Browser fallback so the demo also runs outside Telegram (dev). The
 * encrypted record is still only ciphertext, so this stays non-custodial. */
class LocalStorageAdapter implements Storage {
  async getItem(key: string): Promise<string | null> {
    return window.localStorage.getItem(key);
  }
  async setItem(key: string, value: string): Promise<void> {
    window.localStorage.setItem(key, value);
  }
  async removeItem(key: string): Promise<void> {
    window.localStorage.removeItem(key);
  }
}

export function pickStorage(): Storage {
  if (isInsideTelegram()) {
    try {
      return TelegramCloudStorage.fromWindow();
    } catch {
      /* fall through to localStorage */
    }
  }
  return new LocalStorageAdapter();
}
