/** Pluggable persistence for the encrypted wallet record. The contract is a
 * tiny async key/value store so it maps cleanly onto Telegram CloudStorage,
 * localStorage, or an in-memory map for Node/tests. Only ciphertext is ever
 * written here. */
export interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}
