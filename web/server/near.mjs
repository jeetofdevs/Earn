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

/** True if a recent round on the contract was already drawn for `batch`. */
export async function batchAlreadyDrawn(batch) {
  const [rounds, pending] = await Promise.all([
    gacha("get_rounds", { limit: 50 }),
    gacha("get_pending_draw"),
  ]);
  return Boolean(
    (pending && Number(pending.batch) === batch) || rounds.some((r) => r.batch !== null && Number(r.batch) === batch),
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
