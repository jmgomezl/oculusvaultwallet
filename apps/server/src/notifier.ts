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
  /** Opt-in Agent Desk watch list: uid → JSON array of agent account ids.
   * When present, agent activity (spends, refills, approval requests) is
   * DMed to the owner too. */
  agentWatch?: Pick<VaultStore, "entries">;
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
  /** Schedule ids already announced (approval requests), capped. */
  schedSeen?: string[];
}

function formatAmount(item: { amount: string; token?: { symbol: string } }): string {
  // Sign is carried by the message's verb ("received"/"spent"), not the number.
  const clean = item.amount.replace(/^[+-]/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
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

    // Agent Desk: watched agent accounts. Any movement on an agent account
    // is worth a DM — the whole point of the desk is knowing what the agent
    // does with its budget. Plus new pending approval requests it creates.
    for (const [uid, entry] of deps.agentWatch?.entries() ?? []) {
      let agentIds: string[];
      try {
        agentIds = JSON.parse(entry.record);
        if (!Array.isArray(agentIds)) continue;
      } catch {
        continue;
      }
      for (const agentId of agentIds) {
        try {
          const state = (cursors[`agent:${uid}:${agentId}`] ??= {});
          if (state.cursor === undefined) {
            const latest = await deps.mirror.getHistory(agentId, {
              limit: 1,
              order: "desc",
            });
            state.cursor = latest[0]?.consensusTimestamp ?? "0";
            dirty = true;
          } else {
            const items = await deps.mirror.getHistory(agentId, {
              order: "asc",
              timestampGt: state.cursor,
              limit: 25,
            });
            for (const item of items) {
              state.cursor = item.consensusTimestamp;
              dirty = true;
              const verb = item.direction === "out" ? "spent" : "received";
              await sendMessage(
                uid,
                `🤖 Agent account <code>${agentId}</code> ${verb} <b>${formatAmount(item)}</b>${
                  item.counterparty ? ` ${item.direction === "out" ? "→" : "←"} <code>${item.counterparty}</code>` : ""
                }\n<a href="${item.hashscanUrl}">View on Hashscan</a>`,
              );
            }
          }

          // New approval requests (pending schedules created by the agent).
          const pending = await deps.mirror.getPendingSchedules(agentId);
          const seen = new Set(state.schedSeen ?? []);
          for (const p of pending) {
            if (seen.has(p.scheduleId)) continue;
            seen.add(p.scheduleId);
            dirty = true;
            await sendMessage(
              uid,
              `🔔 Agent account <code>${agentId}</code> is asking you to approve a transaction${
                p.memo ? ` — “${p.memo}”` : ""
              }.\nOpen OculusVault → Agent Desk to review it before it expires.`,
            );
          }
          state.schedSeen = [...seen].slice(-50);
        } catch {
          // Transient mirror failure for this agent — next cycle retries.
        }
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
