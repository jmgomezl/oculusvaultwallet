/**
 * Thin helpers over window.Telegram.WebApp for the client (Mini App) side.
 *
 * IMPORTANT: the user id read here is for UX/namespacing only. Trust comes
 * exclusively from server-side initData verification — always send the raw
 * initData to your backend and use the id it returns for anything sensitive.
 */

export interface TelegramWebAppLike {
  initData: string;
  initDataUnsafe?: { user?: { id?: number }; start_param?: string };
  ready?: () => void;
  expand?: () => void;
  CloudStorage?: unknown;
  showScanQrPopup?: (
    params: { text?: string },
    callback?: (text: string) => boolean | void,
  ) => void;
  closeScanQrPopup?: () => void;
  HapticFeedback?: {
    impactOccurred?: (style: string) => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  openTelegramLink?: (url: string) => void;
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

/**
 * The startapp deep-link parameter, e.g. from
 * t.me/YourBot/app?startapp=pay_0xABC_5. Checks initDataUnsafe first, then the
 * tgWebAppStartParam query key (present on direct-link launches), then a plain
 * ?startapp= for browser testing.
 */
export function getStartParam(): string | null {
  const fromInit = getTelegramWebApp()?.initDataUnsafe?.start_param;
  if (fromInit) return fromInit;
  try {
    const loc = (globalThis as any)?.location;
    const fromSearch = new URLSearchParams(loc?.search ?? "");
    const inSearch =
      fromSearch.get("tgWebAppStartParam") ?? fromSearch.get("startapp");
    if (inSearch) return inSearch;
    // Telegram's web clients (WebK/WebA) deliver launch params in the HASH
    // fragment, not the query string — a pay link opened there would lose
    // its intent unless we look here too.
    const fromHash = new URLSearchParams(
      String(loc?.hash ?? "").replace(/^#/, ""),
    );
    return fromHash.get("tgWebAppStartParam") ?? fromHash.get("startapp");
  } catch {
    return null;
  }
}

/** Whether Telegram's native QR scanner is available (Telegram ≥ 6.4). */
export function canScanQr(): boolean {
  return typeof getTelegramWebApp()?.showScanQrPopup === "function";
}

/**
 * Open Telegram's native QR scanner and resolve with the first scanned text
 * (closing the popup), or null if the user dismisses / scanner unavailable.
 */
export function scanQr(promptText?: string): Promise<string | null> {
  const wa = getTelegramWebApp();
  if (!wa?.showScanQrPopup) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    try {
      wa.showScanQrPopup!({ text: promptText }, (text) => {
        if (!settled) {
          settled = true;
          resolve(text ?? null);
        }
        return true; // close the popup
      });
    } catch {
      if (!settled) resolve(null);
    }
  });
}

/**
 * Show Telegram's native Back button wired to `onClick`, or hide it.
 * Returns a cleanup that unbinds and hides — ideal for useEffect. No-ops
 * outside Telegram.
 */
export function setTelegramBackButton(
  visible: boolean,
  onClick?: () => void,
): () => void {
  const bb = getTelegramWebApp()?.BackButton;
  if (!bb) return () => {};
  try {
    if (visible) {
      if (onClick) bb.onClick(onClick);
      bb.show();
      return () => {
        try {
          if (onClick) bb.offClick(onClick);
          bb.hide();
        } catch {
          /* fine */
        }
      };
    }
    bb.hide();
  } catch {
    /* fine */
  }
  return () => {};
}

/**
 * Open a t.me link without leaving Telegram (native chat picker for
 * share links, instant bot/app opening). Falls back to window.open outside
 * Telegram.
 */
export function openTelegramLink(url: string): void {
  const wa = getTelegramWebApp();
  if (wa?.openTelegramLink) {
    try {
      wa.openTelegramLink(url);
      return;
    } catch {
      /* fall through */
    }
  }
  (globalThis as any)?.open?.(url, "_blank");
}

/** Fire Telegram haptic feedback if available; silently no-ops elsewhere. */
export function haptic(
  kind: "success" | "error" | "warning" | "tap" = "tap",
): void {
  const h = getTelegramWebApp()?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "tap") h.impactOccurred?.("light");
    else h.notificationOccurred?.(kind);
  } catch {
    /* never let UX sugar throw */
  }
}
