// NEAR helpers: read-only calls and the fee wallet signer.
import { Account, FailoverRpcProvider, JsonRpcProvider, actions } from "near-api-js";
import { FEE_WALLET, FEE_WALLET_PRIVATE_KEY, RPC_URLS } from "./config.mjs";

// Falls back to the next RPC if one is down or rate-limited.
export const provider = new FailoverRpcProvider(RPC_URLS.map((url) => new JsonRpcProvider({ url })));

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

export function isAccountId(a) {
  return (
    typeof a === "string" &&
    a.length >= 2 &&
    a.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a)
  );
}

export function parseUnits(text, decimals) {
  const [whole, frac = ""] = String(text || "0").trim().split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatUnits(raw, decimals, digits = 2) {
  const v = BigInt(raw || 0), base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return (v / base).toLocaleString("en-US") + (frac ? "." + frac : "");
}

let tokenMeta = null;
export async function tokenInfo(tokenId) {
  if (!tokenMeta) tokenMeta = await view(tokenId, "ft_metadata").catch(() => null);
  return tokenMeta || { symbol: "EARN", decimals: 18 };
}

export const canSign = () => Boolean(FEE_WALLET && FEE_WALLET_PRIVATE_KEY);

/** Sends many ft_transfer calls to `tokenId` in one transaction. */
export async function sendTransfers(tokenId, transfers, memo) {
  const wallet = new Account(FEE_WALLET, provider, FEE_WALLET_PRIVATE_KEY);
  const acts = transfers.map(([receiver_id, amount]) =>
    actions.functionCall("ft_transfer", { receiver_id, amount: String(amount), memo }, 10_000_000_000_000n, 1n),
  );
  const outcome = await wallet.signAndSendTransaction({
    receiverId: tokenId,
    actions: acts,
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const failed =
    "Failure" in (outcome.status || {}) ||
    (outcome.receipts_outcome || []).some((r) => r.outcome?.status && "Failure" in r.outcome.status);
  return { tx: outcome.transaction?.hash, ok: !failed };
}
