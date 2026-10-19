// Minimal NEAR helpers shared by the server and the draw CLI.
import { Account, JsonRpcProvider } from "near-api-js";
import { CONTRACT_ID, RPC_URL } from "./config.mjs";

export const provider = new JsonRpcProvider({ url: RPC_URL });

export const view = (contractId, method, args = {}) =>
  provider.callFunction({ contractId, method, args });

export const gacha = (method, args) => view(CONTRACT_ID, method, args);

/** NEAR account id rules (named or 64-char implicit). */
export function isAccountId(a) {
  return (
    typeof a === "string" &&
    a.length >= 2 &&
    a.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a)
  );
}

/** True if the contract already drew (or is drawing) `batch`. */
export async function batchAlreadyDrawn(batch) {
  const [stats, pending] = await Promise.all([gacha("get_stats"), gacha("get_pending_draw")]);
  return Boolean(
    (pending && pending.batch !== null && Number(pending.batch) === batch) ||
      (stats.last_batch !== null && Number(stats.last_batch) >= batch),
  );
}

/** Calls `draw` as the owner. Returns the transaction hash. */
export async function sendDraw({ ownerId, privateKey, accounts, batch }) {
  const owner = new Account(ownerId, provider, privateKey);
  const outcome = await owner.callFunctionRaw({
    contractId: CONTRACT_ID,
    methodName: "draw",
    args: { holders: accounts, batch: String(batch) },
    gas: 300_000_000_000_000n,
    waitUntil: "FINAL",
  });
  return outcome.transaction.hash;
}
