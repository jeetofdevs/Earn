// Splits the fee wallet's $EARN between holders, pro-rata to their balance.
import {
  EXCLUDE, FEE_WALLET, KEEP_IN_WALLET, MAX_RECIPIENTS, MIN_HOLD, MIN_PAYOUT, TOKEN_ID,
} from "./config.mjs";
import { balancesOf, listHolders } from "./holders.mjs";
import { canSign, parseUnits, sendTransfers, tokenInfo, view } from "./near.mjs";
import * as store from "./store.mjs";

const BATCH = 25; // ft_transfer calls per transaction (10 Tgas each, 300 Tgas max)

/** Works out who gets what, without sending anything. */
export async function plan() {
  if (!FEE_WALLET) throw new Error("FEE_WALLET is not set.");
  const { decimals } = await tokenInfo(TOKEN_ID);
  const walletBalance = BigInt(await view(TOKEN_ID, "ft_balance_of", { account_id: FEE_WALLET }));
  const keep = parseUnits(KEEP_IN_WALLET, decimals);
  const pool = walletBalance > keep ? walletBalance - keep : 0n;

  const { source, accounts } = await listHolders(TOKEN_ID);
  const candidates = accounts.map((a) => a?.toLowerCase()).filter((a) => a && !EXCLUDE.has(a));
  const balances = await balancesOf(TOKEN_ID, candidates);

  const minHold = parseUnits(MIN_HOLD, decimals);
  const eligible = [...balances]
    .filter(([, b]) => b > 0n && b >= minHold)
    .sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0))
    .slice(0, MAX_RECIPIENTS);
  const totalEligible = eligible.reduce((s, [, b]) => s + b, 0n);

  const minPayout = parseUnits(MIN_PAYOUT, decimals);
  const payouts = [];
  let skipped = 0;
  if (pool > 0n && totalEligible > 0n) {
    for (const [account, bal] of eligible) {
      const amount = (pool * bal) / totalEligible;
      if (amount >= minPayout && amount > 0n) payouts.push([account, amount, bal]);
      else skipped++;
    }
  }
  const total = payouts.reduce((s, p) => s + p[1], 0n);
  return {
    source,
    pool: pool.toString(),
    holders_found: accounts.length,
    holders_eligible: eligible.length,
    total_eligible_balance: totalEligible.toString(),
    recipients: payouts.length,
    skipped_dust: skipped,
    total: total.toString(),
    transactions: Math.ceil(payouts.length / BATCH),
    payouts: payouts.map(([a, amt, bal]) => [a, amt.toString(), bal.toString()]),
  };
}

let running = false;
export const isRunning = () => running;

/** Plans and sends one distribution round. Returns the saved round. */
export async function distribute({ slot, by = "auto" } = {}) {
  if (running) throw new Error("A distribution is already running.");
  if (!canSign()) throw new Error("FEE_WALLET and FEE_WALLET_PRIVATE_KEY must be set.");
  running = true;
  try {
    const p = await plan();
    const id = (store.rounds().at(-1)?.id || 0) + 1;
    const round = {
      id,
      by,
      started_at: Date.now(),
      finished_at: null,
      pool: p.pool,
      holders_eligible: p.holders_eligible,
      total_eligible_balance: p.total_eligible_balance,
      recipients: p.recipients,
      distributed: "0",
      failed: "0",
      batches: [],
      // [account, amount, paid?, balance at snapshot]
      payouts: p.payouts.map(([a, amt, bal]) => [a, amt, false, bal]),
    };
    store.addRound(round, slot);
    if (!p.recipients) {
      store.updateRound(id, { finished_at: Date.now(), note: "Nothing to distribute" });
      return round;
    }

    let paid = 0n, failed = 0n;
    for (let i = 0; i < round.payouts.length; i += BATCH) {
      const chunk = round.payouts.slice(i, i + BATCH);
      let res;
      try {
        res = await sendTransfers(TOKEN_ID, chunk.map(([a, amt]) => [a, amt]), `EARN fee share #${id}`);
      } catch (e) {
        res = { tx: null, ok: false, error: String(e.message || e).slice(0, 200) };
      }
      round.batches.push({ ...res, count: chunk.length });
      for (const p of chunk) {
        p[2] = res.ok;
        if (res.ok) paid += BigInt(p[1]);
        else failed += BigInt(p[1]);
      }
      store.updateRound(id, { batches: round.batches, payouts: round.payouts, distributed: paid.toString(), failed: failed.toString() });
    }
    store.updateRound(id, { finished_at: Date.now() });
    console.log(`Round ${id}: paid ${paid} to ${round.payouts.filter((x) => x[2]).length} holders, failed ${failed}`);
    return round;
  } finally {
    running = false;
  }
}
