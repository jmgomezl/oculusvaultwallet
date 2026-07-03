/**
 * Server-side verification of the Telegram Login Widget payload — how a user
 * proves their Telegram identity OUTSIDE Telegram (website, Chrome extension).
 *
 * Same trust model as Mini App initData, different signature scheme:
 *   secret_key      = SHA256(bot_token)               (plain digest, not HMAC)
 *   data_check_str  = "\n".join(sorted "k=v" for each field except `hash`)
 *   expected_hash   = hex(HMAC_SHA256(key=secret_key, msg=data_check_str))
 *
 * Node-only (node:crypto); exported from the `/server` entrypoint.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { InitDataError, type TelegramUser } from "./initData.js";

/** Raw payload the widget hands to data-onauth / the redirect URL. */
export type TelegramLoginPayload = Record<string, string | number>;

export interface VerifiedLogin {
  user: TelegramUser;
  authDate: Date;
}

export interface VerifyLoginOptions {
  /** Reject payloads older than this many seconds (default 24h). */
  maxAgeSeconds?: number;
  /** Inject a clock for testing (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

/** Verify a Telegram Login Widget payload. Throws InitDataError on failure. */
export function verifyTelegramLogin(
  payload: TelegramLoginPayload,
  botToken: string,
  options: VerifyLoginOptions = {},
): VerifiedLogin {
  if (!botToken) throw new InitDataError("Bot token is required", "malformed");
  if (!payload || typeof payload !== "object") {
    throw new InitDataError("Login payload must be an object", "malformed");
  }

  const providedHash = String(payload.hash ?? "");
  if (!providedHash) {
    throw new InitDataError("Login payload missing hash", "missing_hash");
  }

  const pairs = Object.entries(payload)
    .filter(([k, v]) => k !== "hash" && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(providedHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InitDataError("Login signature mismatch", "bad_signature");
  }

  const authDateSec = Number(payload.auth_date);
  if (Number.isFinite(authDateSec)) {
    const maxAge = options.maxAgeSeconds ?? 86_400;
    const nowMs = (options.now ?? Date.now)();
    const ageSec = nowMs / 1000 - authDateSec;
    if (ageSec > maxAge) {
      throw new InitDataError(
        `Login payload is too old (${Math.round(ageSec)}s > ${maxAge}s)`,
        "expired",
      );
    }
  }

  const id = Number(payload.id);
  if (!Number.isFinite(id)) {
    throw new InitDataError("Login payload has no numeric id", "missing_user");
  }

  return {
    user: {
      id,
      first_name: payload.first_name != null ? String(payload.first_name) : undefined,
      last_name: payload.last_name != null ? String(payload.last_name) : undefined,
      username: payload.username != null ? String(payload.username) : undefined,
      photo_url: payload.photo_url != null ? String(payload.photo_url) : undefined,
    },
    authDate: new Date((Number.isFinite(authDateSec) ? authDateSec : 0) * 1000),
  };
}
