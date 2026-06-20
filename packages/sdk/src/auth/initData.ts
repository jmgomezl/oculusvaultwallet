/**
 * Server-side verification of Telegram Mini App `initData`.
 *
 * SECURITY: never trust the client. The Mini App sends the raw initData query
 * string; the server recomputes the HMAC with the bot token and only then
 * trusts the embedded user. This is the single source of identity for the
 * whole system.
 *
 * Algorithm (per Telegram docs):
 *   secret_key      = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   data_check_str  = "\n".join(sorted "k=v" for each field except `hash`)
 *   expected_hash   = hex(HMAC_SHA256(key=secret_key, msg=data_check_str))
 *   valid           = timingSafeEqual(expected_hash, provided_hash)
 *
 * This module is Node-only (uses node:crypto) and is exported from the
 * `/server` entrypoint.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: Date;
  /** Raw parsed fields for advanced callers. */
  raw: Record<string, string>;
}

export interface VerifyOptions {
  /** Reject initData older than this many seconds (default 24h). */
  maxAgeSeconds?: number;
  /** Inject a clock for testing (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

export class InitDataError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_hash"
      | "bad_signature"
      | "expired"
      | "missing_user"
      | "malformed",
  ) {
    super(message);
    this.name = "InitDataError";
  }
}

/** Verify and parse initData. Throws InitDataError on any failure. */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: VerifyOptions = {},
): VerifiedInitData {
  if (!botToken) throw new InitDataError("Bot token is required", "malformed");

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    throw new InitDataError("initData is not a valid query string", "malformed");
  }

  const providedHash = params.get("hash");
  if (!providedHash) throw new InitDataError("initData missing hash", "missing_hash");

  const pairs: string[] = [];
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    raw[key] = value;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(providedHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InitDataError("initData signature mismatch", "bad_signature");
  }

  // Freshness check guards against replay of a captured initData string.
  const authDateRaw = raw["auth_date"];
  const authDateSec = authDateRaw ? Number(authDateRaw) : NaN;
  if (Number.isFinite(authDateSec)) {
    const maxAge = options.maxAgeSeconds ?? 86_400;
    const nowMs = (options.now ?? Date.now)();
    const ageSec = nowMs / 1000 - authDateSec;
    if (ageSec > maxAge) {
      throw new InitDataError(
        `initData is too old (${Math.round(ageSec)}s > ${maxAge}s)`,
        "expired",
      );
    }
  }

  const userJson = raw["user"];
  if (!userJson) throw new InitDataError("initData missing user", "missing_user");
  let user: TelegramUser;
  try {
    user = JSON.parse(userJson) as TelegramUser;
  } catch {
    throw new InitDataError("initData user is not valid JSON", "malformed");
  }
  if (typeof user.id !== "number") {
    throw new InitDataError("initData user has no numeric id", "missing_user");
  }

  return {
    user,
    authDate: new Date((Number.isFinite(authDateSec) ? authDateSec : 0) * 1000),
    raw,
  };
}
