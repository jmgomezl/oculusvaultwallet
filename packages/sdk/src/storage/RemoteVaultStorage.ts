import type { Storage } from "./Storage.js";

/**
 * Storage backed by a remote OculusVault "vault" API that holds ONLY the
 * encrypted wallet record, keyed server-side by the caller's verified Telegram
 * user id (carried in the bearer token). Because the Telegram user id is the
 * same across every bot, this lets ONE wallet follow a user across multiple
 * apps (kickoff, hbadge, …) — while the server never sees a private key.
 *
 * It is single-slot-per-user: the `key` argument from the KeyProvider is
 * ignored; identity comes from the token. Use the local CloudStorage provider
 * instead if you want per-app wallets.
 */
export interface RemoteVaultOptions {
  /** Base URL of the vault API, e.g. "https://api.oculusvault.com". */
  apiBase: string;
  /** Returns the current session JWT (from POST /api/auth/verify). */
  getToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class RemoteVaultStorage implements Storage {
  private readonly apiBase: string;
  private readonly getToken: RemoteVaultOptions["getToken"];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteVaultOptions) {
    this.apiBase = opts.apiBase.replace(/\/$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private async authHeader(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error("RemoteVaultStorage: no session token available");
    return { authorization: `Bearer ${token}` };
  }

  async getItem(_key: string): Promise<string | null> {
    const res = await this.fetchImpl(`${this.apiBase}/api/vault`, {
      headers: { ...(await this.authHeader()), accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`vault GET failed: ${res.status}`);
    const body = (await res.json()) as { record: string | null };
    return body.record ?? null;
  }

  async setItem(_key: string, value: string): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}/api/vault`, {
      method: "PUT",
      headers: {
        ...(await this.authHeader()),
        "content-type": "application/json",
      },
      body: JSON.stringify({ record: value }),
    });
    if (!res.ok) throw new Error(`vault PUT failed: ${res.status}`);
  }

  async removeItem(_key: string): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}/api/vault`, {
      method: "DELETE",
      headers: await this.authHeader(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`vault DELETE failed: ${res.status}`);
    }
  }
}
