# @oculusvault/sdk

Non-custodial Hedera wallet SDK for Telegram Mini Apps. secp256k1 keys, EVM-alias
auto-create, Mirror Node reads, and a swappable key-management interface. The
default key provider is vendor-free and self-custodial: keys are generated and
encrypted on-device (Argon2id + XChaCha20-Poly1305); only ciphertext is stored.

```bash
npm install @oculusvault/sdk
```

```ts
import { OculusVault, LocalEncryptedKeyProvider, MemoryStorage } from "@oculusvault/sdk";

const wallet = new OculusVault({
  network: "testnet",
  keyProvider: new LocalEncryptedKeyProvider(new MemoryStorage()),
});

const id = await wallet.createOrRecoverWallet({
  userId: "123456",                                  // verified Telegram user id
  secret: { source: "password", value: "hunter2hunter2" },
});

await wallet.getBalance();                 // { hbar, tinybar, usdEstimate }
await wallet.send("0.0.1234", "1.0");
const stop = wallet.onIncoming((t) => console.log("got", t.amount));

wallet.switchNetwork("mainnet");           // same key, same 0x address everywhere
```

Also included: the pay-intent protocol for QR codes / NFC tags / deep links
(`buildPayLink`, `parsePayIntent`), Telegram helpers (`getStartParam`,
`scanQr`, `haptic`), and `RemoteVaultStorage` for a shared, non-custodial
cross-app vault.

Server-side initData verification lives in a separate entrypoint (Node only):

```ts
import { verifyTelegramInitData } from "@oculusvault/sdk/server";
```

See the [main README](https://github.com/jmgomezl/oculusvaultwallet) and
[SECURITY.md](https://github.com/jmgomezl/oculusvaultwallet/blob/main/SECURITY.md)
for the full API, security model, and the end-to-end testnet demo.

## License

Apache-2.0
