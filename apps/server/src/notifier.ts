/**
 * Payment notifier — DMs a user via the Telegram bot when their wallet
 * receives HBAR or a token, even with the app closed. This is the one thing
 * a chat-native wallet can do that a browser wallet can't.
 *
 * Custody note: this reads ONLY public data. Each vault record already
 * carries the user's public evmAddress in the clear (by design — it's an
 * address); the chain data comes from the public Mirror Node. No keys, no
 * secrets, no new information reaches the server.
 *
 * Mechanics: one poll loop over all vault entries. Per user we resolve the
 * account (cached once found), seed a consensus-timestamp cursor on first
 * sight (never replay history), then notify for each new inbound item.
 * Cursors persist to a JSON file so restarts don't re-notify. sendMessage
 * failures (user never pressed Start on the bot, blocked it, …) are par for
 * the course and skipped silently.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { MirrorClient } from "@oculusvault/sdk";
import type { VaultStore } from "./vaultStore.js";

export interface NotifierDeps {
  vault: Pick<VaultStore, "entries">;
  mirror: MirrorClient;
  botToken: string;
  /** Where cursors persist across restarts. */
  cursorFile: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

interface UserCursor {
  accountId?: string;
  /** Consensus timestamp of the last item seen (notify only after this). */
  cursor?: string;
}

function formatAmount(item: { amount: string; token?: { symbol: string } }): string {
  const clean = item.amount.replace(/^\+/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return item.token ? `${clean} ${item.token.symbol}` : `${clean} ℏ`;
}

export function createNotifier(deps: NotifierDeps) {
  const log = deps.log ?? ((m: string) => console.log(`[notifier] ${m}`));
  const fetchImpl = deps.fetchImpl ?? ((input: any, init?: any) => fetch(input, init));
  let cursors: Record<string, UserCursor> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  if (existsSync(deps.cursorFile)) {
    try {
      cursors = JSON.parse(readFileSync(deps.cursorFile, "utf8"));
    } catch {
      log("cursor file unreadable — starting fresh (users get re-seeded, not re-notified)");
    }
  }

  const flush = (): void => {
    const tmp = `${deps.cursorFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(cursors), { mode: 0o600 });
    renameSync(tmp, deps.cursorFile);
  };

  const sendMessage = async (chatId: string, text: string): Promise<void> => {
    try {
      await fetchImpl(
        `https://api.telegram.org/bot${deps.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );
    } catch {
      // Network hiccup or user unreachable — never let it kill the loop.
    }
  };

  /** One pass over all users. Exposed for tests; start() calls it on a timer. */
  const runOnce = async (): Promise<void> => {
    let dirty = false;
    for (const [uid, entry] of deps.vault.entries()) {
      try {
        let evmAddress: string | undefined;
        try {
          evmAddress = JSON.parse(entry.record)?.evmAddress;
        } catch {
          continue; // malformed record — not ours to fix here
        }
        if (!evmAddress) continue;

        const state = (cursors[uid] ??= {});
        if (!state.accountId) {
          const acct = await deps.mirror.resolveAccount(evmAddress);
          if (!acct) continue; // account not created yet
          state.accountId = acct.accountId;
          dirty = true;
        }

        if (state.cursor === undefined) {
          // First sight: seed to the latest existing item — notify only for
          // what happens AFTER we started watching.
          const latest = await deps.mirror.getHistory(state.accountId, {
            limit: 1,
            order: "desc",
          });
          state.cursor = latest[0]?.consensusTimestamp ?? "0";
          dirty = true;
          continue;
        }

        const items = await deps.mirror.getHistory(state.accountId, {
          order: "asc",
          timestampGt: state.cursor,
          limit: 25,
        });
        for (const item of items) {
          state.cursor = item.consensusTimestamp;
          dirty = true;
          if (item.direction !== "in") continue;
          await sendMessage(
            uid,
            `💰 <b>+${formatAmount(item)}</b> received in your OculusVault wallet\n<a href="${item.hashscanUrl}">View on Hashscan</a>`,
          );
        }
      } catch {
        // Transient mirror failure for this user — next cycle retries.
      }
    }
    if (dirty) flush();
  };

  const start = (intervalMs: number): void => {
    const tick = async (): Promise<void> => {
      if (stopped) return;
      await runOnce();
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    log(`watching for inbound payments every ${intervalMs / 1000}s`);
    void tick();
  };

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  return { runOnce, start, stop };
}
