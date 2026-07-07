import "dotenv/config";
import type { HederaNetwork } from "@oculusvault/sdk";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/**
 * Bot-token registry. The primary TELEGRAM_BOT_TOKEN is always registered as
 * "oculusvault". Additional apps (kickoff, hbadge, …) can be registered via
 * TELEGRAM_BOT_TOKENS — a JSON map of appId → bot token — so initData from any
 * of those bots verifies against the SAME shared vault (the Telegram user id is
 * global across bots).
 */
function loadBotTokens(primary: string): Record<string, string> {
  const tokens: Record<string, string> = { oculusvault: primary };
  const raw = process.env.TELEGRAM_BOT_TOKENS;
  if (raw) {
    try {
      Object.assign(tokens, JSON.parse(raw) as Record<string, string>);
    } catch {
      console.warn("⚠️  TELEGRAM_BOT_TOKENS is not valid JSON — ignoring");
    }
  }
  return tokens;
}

const botToken = required("TELEGRAM_BOT_TOKEN", "PLACEHOLDER_BOT_TOKEN");

export const config = {
  port: Number(process.env.PORT ?? 8787),
  network: (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetwork,
  /** Primary BotFather token — verifies initData HMAC. Never sent to client. */
  botToken,
  /** appId → bot token registry for multi-app shared vault. */
  botTokens: loadBotTokens(botToken),
  /** Secret for signing session JWTs. */
  sessionSecret: required("SESSION_SECRET", "dev-only-change-me"),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 3600),
  /** Max initData age accepted (replay protection). */
  initDataMaxAgeSeconds: Number(process.env.INITDATA_MAX_AGE_SECONDS ?? 86_400),
  /** Allow the demo to run outside Telegram with a fake user (NEVER in prod). */
  allowDevAuth: process.env.ALLOW_DEV_AUTH === "true",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Where the encrypted vault records are persisted. */
  vaultDataDir: process.env.VAULT_DATA_DIR ?? "./data",
  /** Reject vault records larger than this (ciphertext is ~1 KB). */
  vaultMaxBytes: Number(process.env.VAULT_MAX_BYTES ?? 16_384),
  /** DM users via the bot when their wallet receives a payment. */
  notifyEnabled: process.env.NOTIFY_ENABLED === "true",
  notifyIntervalMs: Number(process.env.NOTIFY_INTERVAL_MS ?? 60_000),
};

export function assertProdSafety(): void {
  if (config.allowDevAuth) {
    console.warn(
      "⚠️  ALLOW_DEV_AUTH=true — initData verification can be bypassed. Dev only!",
    );
  }
  if (config.botToken === "PLACEHOLDER_BOT_TOKEN") {
    console.warn(
      "⚠️  TELEGRAM_BOT_TOKEN is a placeholder — real initData will fail verification.",
    );
  }
  if (config.sessionSecret === "dev-only-change-me") {
    console.warn("⚠️  SESSION_SECRET is the default — set a strong secret in prod.");
  }
}
