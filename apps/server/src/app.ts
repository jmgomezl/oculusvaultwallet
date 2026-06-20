/**
 * OculusVault backend (app factory).
 *
 * Responsibilities (and ONLY these):
 *   • POST /api/auth/verify          — verify Telegram initData (any registered
 *     bot) and issue a session JWT with the canonical Telegram user id.
 *   • GET/PUT/DELETE /api/vault      — shared, non-custodial CIPHERTEXT store,
 *     keyed by the verified user id. Holds only encrypted records; the server
 *     cannot decrypt them. This is what lets one wallet span multiple apps.
 *   • GET  /api/balance/:acct, /api/history/:acct — Mirror Node read proxy.
 *   • GET  /api/me, /api/health
 *
 * It NEVER sees or stores a private key. Key material lives only on clients.
 */
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { MirrorClient, getNetworkConfig } from "@oculusvault/sdk";
import { verifyTelegramInitData, InitDataError } from "@oculusvault/sdk/server";
import { config } from "./config.js";
import { VaultStore } from "./vaultStore.js";

interface SessionClaims {
  uid: string;
  username?: string;
}
type Authed = Request & { session?: SessionClaims };

export interface AppDeps {
  /** Inject a clock for tests. */
  now?: () => number;
}

export function createApp(deps: AppDeps = {}): Express {
  const now = deps.now ?? Date.now;
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "64kb" }));

  const mirror = new MirrorClient(getNetworkConfig(config.network));
  const vault = new VaultStore(config.vaultDataDir);

  const issueSession = (claims: SessionClaims): string =>
    jwt.sign(claims, config.sessionSecret, {
      expiresIn: config.sessionTtlSeconds,
    });

  function requireSession(req: Authed, res: Response, next: NextFunction): void {
    const auth = req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "missing_session" });
      return;
    }
    try {
      req.session = jwt.verify(token, config.sessionSecret) as SessionClaims;
      next();
    } catch {
      res.status(401).json({ error: "invalid_session" });
    }
  }

  /** Verify initData against the requested app's bot token, or try them all. */
  function verifyAcrossApps(initData: string, appId?: string) {
    const tokens =
      appId && config.botTokens[appId]
        ? [config.botTokens[appId]!]
        : Object.values(config.botTokens);
    let lastErr: unknown;
    for (const token of tokens) {
      try {
        return verifyTelegramInitData(initData, token, {
          maxAgeSeconds: config.initDataMaxAgeSeconds,
          now,
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new InitDataError("no bot tokens configured", "malformed");
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, network: config.network });
  });

  app.post("/api/auth/verify", (req: Request, res: Response) => {
    const initData: unknown = req.body?.initData;
    const appId: string | undefined =
      typeof req.body?.appId === "string" ? req.body.appId : undefined;

    if ((!initData || typeof initData !== "string") && config.allowDevAuth) {
      const uid = String(req.body?.devUserId ?? "999000999");
      return res.json({
        userId: uid,
        user: { id: Number(uid), username: "devuser" },
        token: issueSession({ uid, username: "devuser" }),
        dev: true,
      });
    }
    if (typeof initData !== "string" || initData.length === 0) {
      return res.status(400).json({ error: "missing_initData" });
    }
    try {
      const verified = verifyAcrossApps(initData, appId);
      const uid = String(verified.user.id);
      return res.json({
        userId: uid,
        user: verified.user,
        token: issueSession({ uid, username: verified.user.username }),
      });
    } catch (err) {
      if (err instanceof InitDataError) {
        return res.status(401).json({ error: err.code, message: err.message });
      }
      console.error("verify error", err);
      return res.status(500).json({ error: "internal" });
    }
  });

  app.get("/api/me", requireSession, (req: Authed, res: Response) => {
    res.json({ session: req.session });
  });

  // --- Shared non-custodial vault (ciphertext only) ---
  app.get("/api/vault", requireSession, (req: Authed, res: Response) => {
    const entry = vault.get(req.session!.uid);
    if (!entry) return res.status(404).json({ error: "no_vault" });
    res.json({ record: entry.record, updatedAt: entry.updatedAt });
  });

  app.put("/api/vault", requireSession, (req: Authed, res: Response) => {
    const record: unknown = req.body?.record;
    if (typeof record !== "string" || record.length === 0) {
      return res.status(400).json({ error: "missing_record" });
    }
    if (Buffer.byteLength(record, "utf8") > config.vaultMaxBytes) {
      return res.status(413).json({ error: "record_too_large" });
    }
    // Defense-in-depth: a real encrypted record is JSON with ciphertext + nonce.
    // Reject anything that doesn't look like one (helps catch a client bug that
    // would otherwise upload plaintext).
    try {
      const parsed = JSON.parse(record);
      if (!parsed || typeof parsed.ciphertext !== "string" || !parsed.nonce) {
        return res.status(422).json({ error: "not_an_encrypted_record" });
      }
    } catch {
      return res.status(422).json({ error: "record_not_json" });
    }
    vault.put(req.session!.uid, record, new Date(now()).toISOString());
    res.json({ ok: true });
  });

  app.delete("/api/vault", requireSession, (req: Authed, res: Response) => {
    const had = vault.delete(req.session!.uid);
    res.status(had ? 200 : 404).json({ ok: had });
  });

  // --- Mirror Node read proxy ---
  app.get("/api/balance/:acct", async (req: Request, res: Response) => {
    try {
      const balance = await mirror.getBalance(req.params.acct);
      res.json({ ...balance, tinybar: balance.tinybar.toString() });
    } catch (err) {
      res.status(502).json({ error: "mirror_error", message: String(err) });
    }
  });

  app.get("/api/history/:acct", async (req: Request, res: Response) => {
    try {
      const items = await mirror.getHistory(req.params.acct, {
        limit: Number(req.query.limit ?? 25),
      });
      res.json(items.map((i) => ({ ...i, tinybar: i.tinybar.toString() })));
    } catch (err) {
      res.status(502).json({ error: "mirror_error", message: String(err) });
    }
  });

  return app;
}
