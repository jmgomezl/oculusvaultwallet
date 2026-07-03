/**
 * Thin wrapper over the chrome.* APIs the popup needs, with a localStorage
 * fallback so the popup can be developed/previewed in a plain browser tab
 * (`npm run dev` in apps/extension). In the packed extension the real APIs
 * are always present.
 */

export interface StoredSession {
  token: string;
  userId: string;
  user: { id: number; username?: string; first_name?: string } | null;
  at: number;
}

interface KeyCache {
  privateKeyHex: string;
  network: string;
  exp: number;
}

const HAS_CHROME =
  typeof chrome !== "undefined" && !!chrome.storage?.local;

/** How long an unlocked key survives in chrome.storage.session (memory-only,
 * cleared when the browser closes). Balances safety and popup ergonomics. */
const KEY_CACHE_MS = 15 * 60 * 1000;

export async function getSession(): Promise<StoredSession | null> {
  if (HAS_CHROME) {
    const { session } = await chrome.storage.local.get("session");
    return (session as StoredSession) ?? null;
  }
  const raw = localStorage.getItem("ovext:session");
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

export async function clearSession(): Promise<void> {
  if (HAS_CHROME) {
    await chrome.storage.local.remove("session");
    await chrome.storage.session?.remove?.("keyCache");
  } else {
    localStorage.removeItem("ovext:session");
  }
}

/** Fire cb when a session appears/changes (the link page just connected). */
export function onSessionChange(cb: () => void): () => void {
  if (HAS_CHROME) {
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && "session" in changes) cb();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  const t = setInterval(cb, 2000);
  return () => clearInterval(t);
}

export function openConnectTab(): void {
  const extId = HAS_CHROME ? chrome.runtime.id : "dev";
  const url = `https://oculusvault.com/link.html?ext=${extId}`;
  if (HAS_CHROME && chrome.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, "_blank");
}

/** Cache the unlocked key in memory-backed extension storage (15 min). */
export async function cacheKey(privateKeyHex: string, network: string): Promise<void> {
  const entry: KeyCache = { privateKeyHex, network, exp: Date.now() + KEY_CACHE_MS };
  if (HAS_CHROME && chrome.storage.session) {
    await chrome.storage.session.set({ keyCache: entry });
  }
  // No dev fallback on purpose: never write raw keys to localStorage.
}

export async function getCachedKey(): Promise<KeyCache | null> {
  if (!(HAS_CHROME && chrome.storage.session)) return null;
  const { keyCache } = await chrome.storage.session.get("keyCache");
  const entry = keyCache as KeyCache | undefined;
  if (!entry || entry.exp < Date.now()) return null;
  return entry;
}

export async function dropCachedKey(): Promise<void> {
  if (HAS_CHROME && chrome.storage.session) {
    await chrome.storage.session.remove("keyCache");
  }
}
