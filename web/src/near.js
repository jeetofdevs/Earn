/** Raw token amount -> "1,234.5" */
export function formatUnits(raw, decimals, digits = 2) {
  const v = BigInt(raw || 0);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
