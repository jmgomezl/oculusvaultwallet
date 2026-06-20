import { getInitData } from "@oculusvault/sdk";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

export interface AuthResult {
  userId: string;
  user: { id: number; username?: string; first_name?: string };
  token: string;
  dev?: boolean;
}

/**
 * Authenticate against the backend. Sends the raw Telegram initData for
 * server-side HMAC verification; in a plain browser (no Telegram) it falls
 * back to the dev endpoint if the server allows it.
 */
export async function authenticate(): Promise<AuthResult> {
  const initData = getInitData();
  const res = await fetch(`${API_BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      initData ? { initData } : { devUserId: "demo-" + browserId() },
    ),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Auth failed (${res.status}): ${body.error ?? "unknown"}${
        body.message ? ` — ${body.message}` : ""
      }`,
    );
  }
  return res.json();
}

/** Stable-ish per-browser id for dev mode outside Telegram. */
function browserId(): string {
  const k = "oculusvault:devBrowserId";
  let v = localStorage.getItem(k);
  if (!v) {
    v = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(k, v);
  }
  return v;
}
