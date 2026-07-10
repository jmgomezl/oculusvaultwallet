/**
 * Pay intents — the tiny, public protocol that lets anything (a machine's QR
 * or NFC tag, another app, a chat message) open the wallet pre-filled.
 *
 * Canonical form (Telegram startapp param — only [A-Za-z0-9_-] survives):
 *   pay_<address>                    → open Send to <address>
 *   pay_<address>_<amount>           → …with amount ("-" is the startapp-safe
 *                                      decimal separator, e.g. 1-5 = 1.5)
 *   pay_<address>_<amount>_t<num>    → …in HTS token 0.0.<num> (e.g. t429274
 *                                      = USDC on testnet)
 *   pay_<address>_t<num>             → token request without an amount
 *   to_<address>                     → same as pay_<address>
 *
 * Also accepted by parsePayIntent (scanner input): a raw EVM address, a raw
 * 0.0.x account id, or any URL containing startapp=pay_... .
 * Intents carry ONLY public data (address + amount + token id) — never secrets.
 */

export interface PayIntent {
  /** Recipient: 0x EVM address or 0.0.x account id. */
  to: string;
  /** Optional decimal amount, e.g. "1.5" — HBAR unless `tokenId` is set,
   * in which case it's denominated in that token. */
  amountHbar?: string;
  /** Optional HTS token id (0.0.x) the payment is requested in. */
  tokenId?: string;
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const ACCT_RE = /^0\.0\.[0-9]+$/;
/** startapp-safe account id: 0-0-123 ↔ 0.0.123 */
const ACCT_DASH_RE = /^0-0-[0-9]+$/;
/** startapp-safe token segment: t429274 ↔ token 0.0.429274 */
const TOKEN_SEG_RE = /^t([0-9]+)$/;

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

/** Build a startapp-safe intent string, e.g. buildPayParam("0xabc…", "1.5"). */
export function buildPayParam(
  to: string,
  amountHbar?: string | number,
  tokenId?: string,
): string {
  const addr = to.trim().replace(ACCT_RE.test(to.trim()) ? /\./g : /$^/, "-");
  const amt =
    amountHbar !== undefined ? `_${String(amountHbar).replace(".", "-")}` : "";
  let tok = "";
  if (tokenId !== undefined) {
    const m = /^0\.0\.([0-9]+)$/.exec(tokenId.trim());
    if (!m) throw new Error(`Invalid token id for pay link: "${tokenId}"`);
    tok = `_t${m[1]}`;
  }
  return `pay_${addr}${amt}${tok}`;
}

/**
 * Full t.me deep link that opens the Mini App with this intent.
 *
 * Default form is the bot-level MAIN Mini App link
 * (t.me/<bot>?startapp=…) — field-verified to launch directly with the
 * parameter on iOS. The named form (t.me/<bot>/<appName>?startapp=…)
 * requires a BotFather /newapp registration under that short name; without
 * it, Telegram detours through the bot chat and DROPS the parameter. Pass
 * `appName` only if that registration exists.
 */
export function buildPayLink(
  botUsername: string,
  to: string,
  amountHbar?: string | number,
  tokenId?: string,
  appName?: string,
): string {
  const param = buildPayParam(to, amountHbar, tokenId);
  return appName
    ? `https://t.me/${botUsername}/${appName}?startapp=${param}`
    : `https://t.me/${botUsername}?startapp=${param}`;
}

/**
 * Parse anything a scanner or start_param might hand us into a PayIntent.
 * Returns null when the input is not recognisably an intent or address.
 */
export function parsePayIntent(input: string): PayIntent | null {
  if (!input) return null;
  const s = input.trim();

  // URL carrying a startapp param → recurse on the param.
  if (/^https?:\/\//i.test(s) || s.startsWith("tg://")) {
    const m = s.match(/[?&]startapp=([A-Za-z0-9_-]+)/);
    return m ? parsePayIntent(m[1]!) : null;
  }

  // pay_<addr>[_<amount>][_t<num>] / to_<addr>
  const m = s.match(/^(?:pay|to)_(.+)$/);
  if (m) {
    // The address itself never contains "_" (EVM hex or dashed account id),
    // so the first segment is the address and the rest are modifiers.
    const segments = m[1]!.split("_");
    const addr = normaliseAddress(segments[0]!);
    if (!addr) return null;
    const intent: PayIntent = { to: addr, amountHbar: undefined };
    for (const seg of segments.slice(1)) {
      const tok = TOKEN_SEG_RE.exec(seg);
      if (tok) {
        intent.tokenId = `0.0.${tok[1]}`;
        continue;
      }
      const amt = normaliseAmount(seg);
      if (amt && intent.amountHbar === undefined) intent.amountHbar = amt;
      // Unknown segments are ignored — old wallets stay forward-compatible.
    }
    return intent;
  }

  // Bare address.
  const addr = normaliseAddress(s);
  return addr ? { to: addr } : null;
}
