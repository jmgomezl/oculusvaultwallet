/**
 * Pay intents — the tiny, public protocol that lets anything (a machine's QR
 * or NFC tag, another app, a chat message) open the wallet pre-filled.
 *
 * Canonical form (Telegram startapp param — only [A-Za-z0-9_-] survives):
 *   pay_<address>            → open Send to <address>
 *   pay_<address>_<amount>   → open Send to <address> with amount (use "-" as
 *                              the decimal separator, e.g. 1-5 = 1.5 ℏ)
 *   to_<address>             → same as pay_<address>
 *
 * Also accepted by parsePayIntent (scanner input): a raw EVM address, a raw
 * 0.0.x account id, or any URL containing startapp=pay_... .
 * Intents carry ONLY public data (address + amount) — never secrets.
 */

export interface PayIntent {
  /** Recipient: 0x EVM address or 0.0.x account id. */
  to: string;
  /** Optional decimal HBAR amount, e.g. "1.5". */
  amountHbar?: string;
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const ACCT_RE = /^0\.0\.[0-9]+$/;
/** startapp-safe account id: 0-0-123 ↔ 0.0.123 */
const ACCT_DASH_RE = /^0-0-[0-9]+$/;

function normaliseAddress(raw: string): string | null {
  const s = raw.trim();
  if (EVM_RE.test(s)) return s;
  if (ACCT_RE.test(s)) return s;
  if (ACCT_DASH_RE.test(s)) return s.replace(/-/g, ".");
  return null;
}

function normaliseAmount(raw: string): string | undefined {
  // "-" is the startapp-safe decimal separator; "." accepted directly.
  const s = raw.replace("-", ".");
  return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? s : undefined;
}

/** Build a startapp-safe intent string, e.g. payLinkParam("0xabc…", "1.5"). */
export function buildPayParam(to: string, amountHbar?: string | number): string {
  const addr = to.trim().replace(ACCT_RE.test(to.trim()) ? /\./g : /$^/, "-");
  const amt =
    amountHbar !== undefined ? `_${String(amountHbar).replace(".", "-")}` : "";
  return `pay_${addr}${amt}`;
}

/** Full t.me deep link that opens the Mini App with this intent. */
export function buildPayLink(
  botUsername: string,
  to: string,
  amountHbar?: string | number,
  appName = "app",
): string {
  return `https://t.me/${botUsername}/${appName}?startapp=${buildPayParam(to, amountHbar)}`;
}

/**
 * Parse anything a scanner or start_param might hand us into a PayIntent.
 * Returns null when the input is not recognisably an intent or address.
 */
export function parsePayIntent(input: string): PayIntent | null {
  if (!input) return null;
  let s = input.trim();

  // URL carrying a startapp param → recurse on the param.
  if (/^https?:\/\//i.test(s) || s.startsWith("tg://")) {
    const m = s.match(/[?&]startapp=([A-Za-z0-9_-]+)/);
    return m ? parsePayIntent(m[1]!) : null;
  }

  // pay_<addr>[_<amt>] / to_<addr>
  const m = s.match(/^(?:pay|to)_(.+)$/);
  if (m) {
    const rest = m[1]!;
    // Amount is the last _segment IF the prefix before it is a valid address.
    const cut = rest.lastIndexOf("_");
    if (cut > 0) {
      const addr = normaliseAddress(rest.slice(0, cut));
      const amt = normaliseAmount(rest.slice(cut + 1));
      if (addr) return { to: addr, amountHbar: amt };
    }
    const addr = normaliseAddress(rest);
    return addr ? { to: addr } : null;
  }

  // Bare address.
  const addr = normaliseAddress(s);
  return addr ? { to: addr } : null;
}
