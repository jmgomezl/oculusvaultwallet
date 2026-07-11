import { getInitData, isInsideTelegram } from "@oculusvault/sdk";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

/**
 * Demo mode = running in a plain browser, where no Telegram identity exists.
 * The demo is a self-contained sandbox: wallet keys live only in THIS browser
 * (localStorage), testnet only, and no backend session is needed at all.
 * The real wallet — shared vault, mainnet — requires the Telegram Mini App,
 * because the whole security model hangs off the verified Telegram identity.
 */
export function isDemoMode(): boolean {
  return !isInsideTelegram();
}

/** Current session JWT, set after a REAL authenticate(); used by
 * RemoteVaultStorage. Always null in demo mode. */
let currentToken: string | null = null;
export function getToken(): string | null {
  return currentToken;
}

export interface AuthResult {
  userId: string;
  user: { id: number; username?: string; first_name?: string };
  token: string;
  /** Deep-link start parameter from the server-verified initData (the HMAC
   * covers it) — more reliable than client-side extraction on some
   * platforms. */
  startParam?: string;
  demo?: boolean;
}

/**
 * Authenticate. Inside Telegram: send the raw initData to the backend for
 * server-side HMAC verification and get a session. In a browser: no server
 * call — return a local sandbox identity for the demo.
 */
export async function authenticate(): Promise<AuthResult> {
  if (isDemoMode()) {
    return {
      userId: "demo-" + browserId(),
      user: { id: 0, username: "demo" },
      token: "",
      demo: true,
    };
  }

  const res = await fetch(`${API_BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: getInitData() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Auth failed (${res.status}): ${body.error ?? "unknown"}${
        body.message ? ` — ${body.message}` : ""
      }`,
    );
  }
  const result = (await res.json()) as AuthResult;
  currentToken = result.token;
  return result;
}

/**
 * Keep the server's agent-notification watch list in step with the roster
 * (Agent Desk). Best-effort and real-session only: in demo mode there is no
 * bot to DM. Account ids are public on-chain data.
 */
export async function syncAgentWatchList(accountIds: string[]): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${API_BASE}/api/notify/agents`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ accountIds }),
    });
  } catch {
    // Notifications are a convenience — never let this break the desk.
  }
}

/** Stable per-browser id so the demo wallet survives page reloads. */
function browserId(): string {
  const k = "oculusvault:devBrowserId";
  let v = localStorage.getItem(k);
  if (!v) {
    v = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(k, v);
  }
  return v;
}
