/**
 * WebAuthn passkey PRF as a hardware-backed secret source.
 *
 * The PRF extension lets a passkey deterministically produce 32 bytes of
 * entropy bound to the authenticator — the user authenticates with biometrics
 * and we get a stable secret with NOTHING to memorise. We then feed those
 * bytes through Argon2id like any other secret.
 *
 * CAVEAT: PRF support inside Telegram in-app webviews is inconsistent across
 * platforms. ALWAYS feature-detect with isPasskeyPrfLikelySupported() and fall
 * back to a password. We verify real availability at registration time before
 * committing a wallet to it.
 */
import type { UserSecret } from "./encryption.js";
import { utf8ToBytes } from "./encoding.js";

/** Cheap capability probe (does NOT guarantee PRF works — confirm at runtime). */
export async function isPasskeyPrfLikelySupported(): Promise<boolean> {
  try {
    if (typeof PublicKeyCredential === "undefined") return false;
    if (
      typeof (PublicKeyCredential as any)
        .isUserVerifyingPlatformAuthenticatorAvailable !== "function"
    ) {
      return false;
    }
    return await (
      PublicKeyCredential as any
    ).isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export interface PasskeyOptions {
  /** Relying-party id (your domain, e.g. "wallet.example.com"). */
  rpId: string;
  rpName: string;
  /** Stable user handle — use the verified Telegram user id. */
  userId: string;
  userName: string;
  /** Stable PRF input salt; keep constant for the same wallet. */
  prfSalt?: Uint8Array;
}

const DEFAULT_PRF_SALT = utf8ToBytes("oculusvault:prf:v1");

function randomChallenge(): Uint8Array {
  const c = new Uint8Array(32);
  crypto.getRandomValues(c);
  return c;
}

function extractPrf(cred: PublicKeyCredential | null): Uint8Array | null {
  const results: any = (cred as any)?.getClientExtensionResults?.();
  const first = results?.prf?.results?.first;
  if (!first) return null;
  return new Uint8Array(first as ArrayBuffer);
}

/** Register a new passkey and return its PRF secret, or null if PRF is
 * unsupported on this device (caller should fall back to a password). */
export async function registerPasskeySecret(
  opts: PasskeyOptions,
): Promise<UserSecret | null> {
  const salt = opts.prfSalt ?? DEFAULT_PRF_SALT;
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge() as BufferSource,
      rp: { id: opts.rpId, name: opts.rpName },
      user: {
        id: utf8ToBytes(opts.userId) as BufferSource,
        name: opts.userName,
        displayName: opts.userName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "required",
      },
      extensions: { prf: { eval: { first: salt } } } as any,
    },
  })) as PublicKeyCredential | null;

  const prf = extractPrf(cred);
  return prf ? { source: "passkey-prf", value: prf } : null;
}

/** Authenticate with an existing passkey and return its PRF secret. */
export async function getPasskeySecret(
  opts: Pick<PasskeyOptions, "rpId" | "prfSalt">,
): Promise<UserSecret | null> {
  const salt = opts.prfSalt ?? DEFAULT_PRF_SALT;
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge() as BufferSource,
      rpId: opts.rpId,
      userVerification: "required",
      extensions: { prf: { eval: { first: salt } } } as any,
    },
  })) as PublicKeyCredential | null;

  const prf = extractPrf(cred);
  return prf ? { source: "passkey-prf", value: prf } : null;
}
