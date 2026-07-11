/**
 * HTS fungible-token write path via @hashgraph/sdk: association + transfer.
 *
 * Same custody model as the HBAR path — we sign locally with the sender's
 * ECDSA key; no key ever leaves the device. Amounts travel as bigints in the
 * token's smallest units (see tokenAmount.ts) — never floats.
 *
 * Hedera specifics worth knowing:
 * - A recipient must be ASSOCIATED with a token to receive it (or have
 *   automatic-association slots free — accounts auto-created via EVM alias
 *   get unlimited auto-association since HIP-904).
 * - Association is an on-ledger transaction paid by the associating account,
 *   so it needs a little HBAR for the fee.
 */
import {
  AccountId,
  Long,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenId,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { parseTokenAmount } from "./tokenAmount.js";
import { clientFor, recipientAccountId } from "./transfer.js";

export { USDC_TOKEN_IDS, SUGGESTED_TOKENS, type KnownToken } from "./knownTokens.js";

/** Map Hedera status codes to sentences a wallet user can act on. */
function friendlyTokenError(err: unknown): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/TOKEN_NOT_ASSOCIATED_TO_ACCOUNT|NO_REMAINING_AUTOMATIC_ASSOCIATIONS/.test(msg)) {
    return new Error(
      "The recipient hasn’t enabled this token — they need to add it in their wallet first.",
    );
  }
  if (/INSUFFICIENT_TOKEN_BALANCE/.test(msg)) {
    return new Error("Not enough of this token to send that amount.");
  }
  if (/INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE/.test(msg)) {
    return new Error("Not enough HBAR to pay the network fee.");
  }
  if (/TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT/.test(msg)) {
    return new Error("This token is already added to your wallet.");
  }
  if (/SENDER_DOES_NOT_OWN_NFT_SERIAL_NO|INVALID_NFT_ID/.test(msg)) {
    return new Error("This wallet doesn’t own that NFT serial.");
  }
  if (/TOKEN_HAS_NO_SUPPLY_KEY|INVALID_SUPPLY_KEY|INVALID_SIGNATURE.*mint/i.test(msg)) {
    return new Error("Only the collection's creator (supply-key holder) can mint into it.");
  }
  if (/INVALID_TOKEN_ID/.test(msg)) {
    return new Error("That token id doesn't exist on this network.");
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface SendTokenArgs {
  network: HederaNetwork;
  senderAccountId: string;
  senderPrivateKeyHex: string;
  to: string;
  tokenId: string;
  /** Amount in the token's smallest units (use parseTokenAmount). */
  amountRaw: bigint;
  memo?: string;
}

export async function sendToken(args: SendTokenArgs): Promise<SendResult> {
  if (args.amountRaw <= 0n) throw new Error("Token amount must be positive");
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const senderKey = PrivateKey.fromStringECDSA(args.senderPrivateKeyHex);
  const senderId = AccountId.fromString(args.senderAccountId);
  client.setOperator(senderId, senderKey);

  try {
    const token = TokenId.fromString(args.tokenId);
    const amount = Long.fromString(args.amountRaw.toString());
    let tx = new TransferTransaction()
      .addTokenTransfer(token, senderId, amount.negate())
      .addTokenTransfer(token, recipientAccountId(args.to), amount);
    if (args.memo) tx = tx.setTransactionMemo(args.memo);

    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}

export interface CreateFungibleTokenArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  name: string;
  symbol: string;
  /** 0–8 keeps amounts sane in wallet UIs (USDC uses 6). */
  decimals: number;
  /** Human decimal amount minted to the creator, e.g. "1000". */
  initialSupply: string;
}

export interface CreateTokenResult extends SendResult {
  tokenId: string;
}

/**
 * Create a fungible HTS token with this wallet as treasury. Admin + supply
 * keys are the wallet's key, so the creator keeps full control (can mint
 * more or update later); anyone can hold it via normal association.
 */
export async function createFungibleToken(
  args: CreateFungibleTokenArgs,
): Promise<CreateTokenResult> {
  const name = args.name.trim();
  const symbol = args.symbol.trim().toUpperCase();
  if (!name || name.length > 100) throw new Error("Token name: 1–100 characters");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) {
    throw new Error("Symbol: 1–10 letters/digits");
  }
  if (!Number.isInteger(args.decimals) || args.decimals < 0 || args.decimals > 8) {
    throw new Error("Decimals must be 0–8");
  }
  const supplyRaw = parseTokenAmount(args.initialSupply, args.decimals);
  if (supplyRaw <= 0n) throw new Error("Initial supply must be positive");

  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  const treasury = AccountId.fromString(args.accountId);
  client.setOperator(treasury, key);

  try {
    const response = await new TokenCreateTransaction()
      .setTokenName(name)
      .setTokenSymbol(symbol)
      .setDecimals(args.decimals)
      .setInitialSupply(Long.fromString(supplyRaw.toString()))
      .setTreasuryAccountId(treasury)
      .setAdminKey(key.publicKey)
      .setSupplyKey(key.publicKey)
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.tokenId) throw new Error("Network returned no token id");
    const transactionId = response.transactionId.toString();
    return {
      tokenId: receipt.tokenId.toString(),
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}

export interface CreateNftCollectionArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  /** Collection name, e.g. "Engraved Postcards". */
  name: string;
  /** 1–10 letters/digits, e.g. "CARD". */
  symbol: string;
}

/**
 * Create a non-fungible collection with this wallet as treasury. Admin +
 * supply keys are the wallet's key: the creator mints serials (mintNft) and
 * keeps control; anyone can hold them via normal association / HIP-904
 * auto-association.
 */
export async function createNftCollection(
  args: CreateNftCollectionArgs,
): Promise<CreateTokenResult> {
  const name = args.name.trim();
  const symbol = args.symbol.trim().toUpperCase();
  if (!name || name.length > 100) throw new Error("Collection name: 1–100 characters");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) {
    throw new Error("Symbol: 1–10 letters/digits");
  }
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  const treasury = AccountId.fromString(args.accountId);
  client.setOperator(treasury, key);

  try {
    const response = await new TokenCreateTransaction()
      .setTokenName(name)
      .setTokenSymbol(symbol)
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Infinite)
      .setTreasuryAccountId(treasury)
      .setAdminKey(key.publicKey)
      .setSupplyKey(key.publicKey)
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.tokenId) throw new Error("Network returned no token id");
    const transactionId = response.transactionId.toString();
    return {
      tokenId: receipt.tokenId.toString(),
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}

export interface MintNftArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  /** A collection this wallet holds the supply key for. */
  tokenId: string;
  /** Serial metadata — conventionally a URI (ipfs://… or https://…) to an
   * image or HIP-412 JSON. HARD on-chain limit: 100 BYTES. */
  metadataUri: string;
}

export interface MintNftResult extends SendResult {
  /** Serial number(s) minted by this call. */
  serials: number[];
}

/** Mint one serial into a collection this wallet controls. The metadata is
 * what wallets/marketplaces resolve to display the piece — keep it a URI. */
export async function mintNft(args: MintNftArgs): Promise<MintNftResult> {
  const uri = args.metadataUri.trim();
  if (!/^(ipfs:\/\/|https?:\/\/)/i.test(uri)) {
    throw new Error("Metadata must be an ipfs:// or https:// URI");
  }
  const bytes = new TextEncoder().encode(uri);
  if (bytes.length > 100) {
    throw new Error(
      `Metadata URI is ${bytes.length} bytes — the network caps it at 100. Use an ipfs:// CID or a short URL.`,
    );
  }
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  client.setOperator(AccountId.fromString(args.accountId), key);

  try {
    const response = await new TokenMintTransaction()
      .setTokenId(TokenId.fromString(args.tokenId))
      .setMetadata([bytes])
      .execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      serials: (receipt.serials ?? []).map((s) => Number(s.toString())),
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}

export interface SendNftArgs {
  network: HederaNetwork;
  senderAccountId: string;
  senderPrivateKeyHex: string;
  to: string;
  tokenId: string;
  serialNumber: number;
  memo?: string;
}

/** Transfer one NFT serial. The recipient must be associated with the
 * collection or have automatic-association slots free (alias-created
 * accounts have unlimited auto-association since HIP-904). */
export async function sendNft(args: SendNftArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const senderKey = PrivateKey.fromStringECDSA(args.senderPrivateKeyHex);
  const senderId = AccountId.fromString(args.senderAccountId);
  client.setOperator(senderId, senderKey);

  try {
    let tx = new TransferTransaction().addNftTransfer(
      TokenId.fromString(args.tokenId),
      args.serialNumber,
      senderId,
      recipientAccountId(args.to),
    );
    if (args.memo) tx = tx.setTransactionMemo(args.memo);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}

export interface AssociateTokenArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  tokenId: string;
}

/** Opt the account in to a token so it can receive it. Costs a small HBAR fee. */
export async function associateToken(
  args: AssociateTokenArgs,
): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  const accountId = AccountId.fromString(args.accountId);
  client.setOperator(accountId, key);

  try {
    const tx = new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([TokenId.fromString(args.tokenId)]);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}
