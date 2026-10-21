// Finds $EARN holders: an indexer gives the list, then every balance is
// re-read on-chain so payouts use real, current balances.
import { FASTNEAR_URL, NEARBLOCKS_API_KEY, NEARBLOCKS_URL } from "./config.mjs";
import { isAccountId, view } from "./near.mjs";

async function fromNearBlocks(tokenId) {
  const out = [];
  const headers = NEARBLOCKS_API_KEY ? { Authorization: `Bearer ${NEARBLOCKS_API_KEY}` } : {};
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(`${NEARBLOCKS_URL}/v1/fts/${tokenId}/holders?page=${page}&per_page=100`, { headers });
    if (!res.ok) throw new Error(`NearBlocks HTTP ${res.status}`);
    const rows = (await res.json()).holders || [];
    out.push(...rows.map((r) => r.account ?? r.account_id));
    if (rows.length < 100) break;
    await new Promise((r) => setTimeout(r, 350)); // stay under rate limits
  }
  return out;
}

async function fromFastNear(tokenId) {
  const res = await fetch(`${FASTNEAR_URL}/v1/ft/${tokenId}/top`);
  if (!res.ok) throw new Error(`FastNEAR HTTP ${res.status}`);
  return ((await res.json()).accounts || []).map((r) => r.account_id);
}

/** Accounts that may hold the token (unverified). */
export async function listHolders(tokenId) {
  try {
    const list = await fromNearBlocks(tokenId);
    if (list.length) return { source: "nearblocks", accounts: list };
  } catch (e) {
    console.warn("NearBlocks holders failed:", e.message);
  }
  return { source: "fastnear", accounts: await fromFastNear(tokenId) };
}

/** Reads each account's balance on-chain, a few at a time. */
export async function balancesOf(tokenId, accounts, concurrency = 8) {
  const result = new Map();
  const queue = [...new Set(accounts.filter(isAccountId))];
  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      try {
        result.set(a, BigInt(await view(tokenId, "ft_balance_of", { account_id: a })));
      } catch {
        // Skip accounts we can't read this round.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}
