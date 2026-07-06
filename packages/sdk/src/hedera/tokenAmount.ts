/**
 * Exact decimal ⇄ smallest-unit conversion for HTS fungible tokens.
 * All math is bigint — token amounts must never round-trip through floats
 * (a 6-decimal USDC balance already exceeds float-safe integers at ~9e9).
 */

/** "1500000" raw with 6 decimals → "1.5"; trims trailing zeros. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  if (decimals === 0) return `${neg ? "-" : ""}${abs}`;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "1.5" with 6 decimals → 1500000n. Rejects malformed input and more
 * fractional digits than the token supports (never silently truncates). */
export function parseTokenAmount(
  amount: string | number,
  decimals: number,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const s = String(amount).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Invalid token amount: "${s}"`);
  const sign = m[1];
  const whole = m[2]!;
  const frac = m[3] ?? "";
  if (frac.length > decimals) {
    throw new Error(
      `Too many decimal places for this token: "${s}" (max ${decimals})`,
    );
  }
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0");
  return sign ? -raw : raw;
}
