/**
 * @oculusvault/sdk/server — Node-only entrypoint.
 *
 * Exposes the Telegram initData verifier (uses node:crypto). Import this from
 * your backend; never from browser code.
 */
export {
  verifyTelegramLogin,
  type TelegramLoginPayload,
  type VerifiedLogin,
  type VerifyLoginOptions,
} from "./auth/telegramLogin.js";
export {
  verifyTelegramInitData,
  InitDataError,
  type TelegramUser,
  type VerifiedInitData,
  type VerifyOptions,
} from "./auth/initData.js";
