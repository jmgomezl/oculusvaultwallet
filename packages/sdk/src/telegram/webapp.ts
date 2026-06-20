/**
 * Thin helpers over window.Telegram.WebApp for the client (Mini App) side.
 *
 * IMPORTANT: the user id read here is for UX/namespacing only. Trust comes
 * exclusively from server-side initData verification — always send the raw
 * initData to your backend and use the id it returns for anything sensitive.
 */

export interface TelegramWebAppLike {
  initData: string;
  initDataUnsafe?: { user?: { id?: number } };
  ready?: () => void;
  expand?: () => void;
  CloudStorage?: unknown;
}

export function getTelegramWebApp(): TelegramWebAppLike | null {
  return (globalThis as any)?.Telegram?.WebApp ?? null;
}

/** Raw initData query string to POST to your backend for verification. */
export function getInitData(): string {
  const wa = getTelegramWebApp();
  return wa?.initData ?? "";
}

/** Best-effort client-side user id for namespacing ONLY (not trusted). */
export function getUnsafeUserId(): number | null {
  return getTelegramWebApp()?.initDataUnsafe?.user?.id ?? null;
}

/** Call Telegram's ready()/expand() if present. Safe to call outside Telegram. */
export function initTelegram(): void {
  const wa = getTelegramWebApp();
  wa?.ready?.();
  wa?.expand?.();
}

export function isInsideTelegram(): boolean {
  return Boolean(getTelegramWebApp()?.initData);
}
