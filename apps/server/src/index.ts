/**
 * Thin backend for the Hedera Telegram Wallet.
 *
 * Responsibilities (and ONLY these):
 *   • POST /api/auth/verify  — verify Telegram initData server-side, issue a
 *     short-lived session JWT containing the VERIFIED user id.
 *   • GET  /api/me           — echo the verified session (debug/demo).
 *   • GET  /api/balance/:acct, /api/history/:acct — optional Mirror Node proxy
 *     so the client can avoid CORS / hide the upstream.
 *   • GET  /api/health
 *
 * It NEVER sees or stores a private key. Key material lives only on the client.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import {
  MirrorClient,
  getNetworkConfig,
} from "@oculusvault/sdk";
import {
  verifyTelegramInitData,
  InitDataError,
} from "@oculusvault/sdk/server";
import { config, assertProdSafety } from "./config.js";

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "64kb" }));

const mirror = new MirrorClient(getNetworkConfig(config.network));

interface SessionClaims {
  uid: string;
  username?: string;
}

function issueSession(claims: SessionClaims): string {
  return jwt.sign(claims, config.sessionSecret, {
    expiresIn: config.sessionTtlSeconds,
  });
}

/** Express middleware: require a valid Bearer session JWT. */
function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "missing_session" });
    return;
  }
  try {
    const claims = jwt.verify(token, config.sessionSecret) as SessionClaims;
    (req as Request & { session?: SessionClaims }).session = claims;
    next();
  } catch {
    res.status(401).json({ error: "invalid_session" });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, network: config.network });
});

/**
 * Verify initData and mint a session. The returned `userId` is the only
 * trusted identity the client should use to namespace its wallet.
 */
app.post("/api/auth/verify", (req: Request, res: Response) => {
  const initData: unknown = req.body?.initData;

  // Dev escape hatch (guarded). Lets you run the Mini App in a browser.
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
    const verified = verifyTelegramInitData(initData, config.botToken, {
      maxAgeSeconds: config.initDataMaxAgeSeconds,
    });
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

app.get("/api/me", requireSession, (req: Request, res: Response) => {
  res.json({ session: (req as Request & { session?: SessionClaims }).session });
});

// --- Optional Mirror Node proxy (read-only) ---
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

assertProdSafety();
app.listen(config.port, () => {
  console.log(
    `oculusvault server on :${config.port} (network=${config.network})`,
  );
});
