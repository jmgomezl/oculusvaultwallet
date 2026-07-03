# Security model

This document states precisely what is and isn't custodial, the cryptography
used, the threat model, and the known limitations. If you find a discrepancy
between this document and the code, treat it as a bug and open an issue.

## TL;DR

- **The server never sees or stores a private key.** Keys are generated on the
  device and stored only as ciphertext.
- **The wrapping secret never leaves the device.** It is a user password or a
  WebAuthn passkey-PRF value.
- **The Telegram identity authorizes, it never seeds.** We never derive a key
  from the Telegram user id.

## What is custodial vs not

| Component | Sees private key? | Notes |
| --- | --- | --- |
| Mini App (client) | **Yes, transiently in memory** | Generates/decrypts the key locally; `lock()` wipes it. |
| User secret (password / passkey PRF) | n/a | Lives only on the device; never transmitted. |
| Telegram CloudStorage | **No** | Stores only the encrypted record (ciphertext + KDF params). |
| Backend server | **No** | Verifies initData and issues sessions. Cannot decrypt the record. |
| Mirror Node / Hashio | **No** | Read-only public infrastructure / RPC relay. |

This is **self-custodial**: only someone with both the stored ciphertext *and*
the user secret can recover the key. The operator of this software cannot.

## Cryptography

All primitives are audited, widely-used libraries. **No cryptography is
hand-rolled, and there is no DIY MPC/threshold scheme.**

- **Key:** secp256k1 (`@noble/curves`). The EVM address is `keccak256(pubkey)[-20:]`,
  EIP-55 checksummed. The same key is a Hedera account via its EVM alias.
- **Envelope encryption:** XChaCha20-Poly1305 (`@noble/ciphers`), 24-byte random
  nonce, authenticated (Poly1305 tag) so a wrong secret fails loudly.
- **Key derivation:** Argon2id (`hash-wasm`), memory-hard. Defaults: 64 MiB,
  3 iterations, 32-byte output, random 16-byte salt. Tunable via `DEFAULT_KDF`.
- **Randomness:** platform CSPRNG (`crypto.getRandomValues` / Node `webcrypto`).

The stored record contains only: version, public EVM address, KDF params
(salt + costs), nonce, ciphertext, secret source, timestamp. It is asserted in
tests that the plaintext key never appears in the record.

## Where the wallet can exist

**The wallet runs only inside the Telegram Mini App.** A plain browser sees the
product landing page and nothing else — no wallet UI, no key generation, even
when following a pay deep-link. This is deliberate: the security model hangs
off the server-verified Telegram identity, so an unverified browser visitor
must never be able to create something that looks like a real wallet.
(`VITE_FORCE_WALLET=true` exists as a gitignored, local-development-only
escape hatch for working on the wallet UI.)

## Mainnet guardrails

The same secp256k1 key — and therefore the same 0x address — is valid on
every Hedera network; only the per-network account id differs. The app is
testnet by default. Switching to mainnet requires a one-time, plain-words
confirmation (real HBAR, unaudited beta, keep small amounts, back up first),
the acknowledgment is remembered, and mainnet mode is visually distinct (gold
ink, persistent warning strip); the send-confirmation screen states
"mainnet — real HBAR" explicitly.

## Telegram authentication

`initData` is verified **server-side** per Telegram's spec:

```
secret_key    = HMAC_SHA256(key="WebAppData", msg=bot_token)
data_check    = "\n".join(sorted "k=v" for fields except hash)
expected_hash = HMAC_SHA256(key=secret_key, msg=data_check)
valid         = timingSafeEqual(expected_hash, provided_hash)
```

- The comparison is constant-time.
- `auth_date` freshness is enforced (`INITDATA_MAX_AGE_SECONDS`, default 24h) to
  blunt replay of a captured initData string.
- The client is **never** trusted: the user id used for anything sensitive comes
  from the server's verification, not from `initDataUnsafe`.

## Secret source: passkey vs password

- **Passkey PRF** (preferred): hardware-backed, nothing to memorize, phishing
  resistant. **Caveat:** PRF support inside Telegram in-app webviews is
  inconsistent across platforms — we feature-detect and confirm at registration
  before committing a wallet to it.
- **Password** (fallback, reliable everywhere): only as strong as the password.
  Argon2id raises the cost of offline guessing against a stolen ciphertext, but
  cannot save a trivial password. The UI enforces a minimum length; consider a
  stronger policy for higher-value deployments.

## Threat model

**Protected against**

- A malicious or compromised **server**: it has no key material and cannot
  decrypt records. The worst it can do is deny service or lie about balances
  (clients can read Mirror Node directly to verify).
- A leaked **CloudStorage** record: useless without the user secret (subject to
  password strength).
- **Forged / replayed initData**: rejected by HMAC + freshness checks.
- **Telegram-id enumeration**: ids are public, but they are not the seed and
  grant no access without the user secret.

**NOT protected against**

- A **compromised client device / webview** (malware, hostile injected script):
  it can observe the key while unlocked. This is inherent to any
  browser/webview wallet.
- A **weak user password** combined with a stolen ciphertext: brute-forceable.
- **Lost secret**: by design there is no recovery/backdoor. Losing the
  password/passkey means losing the wallet. Encourage users to `exportKey()` and
  back it up.
- **Supply-chain compromise** of dependencies (mitigate with lockfiles, audits,
  Subresource Integrity for the Telegram script in production).

## Production hardening checklist

Already built into the server: per-IP rate limiting on auth and vault writes,
security headers (`nosniff`, `X-Frame-Options: DENY`, no-referrer), vault
records validated to be encrypted and size-capped, `x-powered-by` disabled.
Still on you when deploying:

- [ ] `ALLOW_DEV_AUTH=false`.
- [ ] Strong random `SESSION_SECRET`.
- [ ] Restrict `CORS_ORIGIN` to your Mini App URL.
- [ ] Serve the Mini App over HTTPS; pin the Telegram WebApp script (SRI).
- [ ] Consider raising Argon2id memory/iterations for your device targets.
- [ ] Clear, scary backup/export messaging — there is no recovery.

## Reporting a vulnerability

Please open a private security advisory or contact the maintainer directly
rather than filing a public issue for sensitive reports.
