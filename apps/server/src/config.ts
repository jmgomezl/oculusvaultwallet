import "dotenv/config";
import type { HederaNetwork } from "@oculusvault/sdk";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  network: (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetwork,
  /** BotFather token — used ONLY to verify initData HMAC. Never sent to client. */
  botToken: required("TELEGRAM_BOT_TOKEN", "PLACEHOLDER_BOT_TOKEN"),
  /** Secret for signing session JWTs. */
  sessionSecret: required("SESSION_SECRET", "dev-only-change-me"),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 3600),
  /** Max initData age accepted (replay protection). */
  initDataMaxAgeSeconds: Number(process.env.INITDATA_MAX_AGE_SECONDS ?? 86_400),
  /** Allow the demo to run outside Telegram with a fake user (NEVER in prod). */
  allowDevAuth: process.env.ALLOW_DEV_AUTH === "true",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
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
