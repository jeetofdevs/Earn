// Hidden owner page: connect the owner wallet and pull the gacha per batch.
import "./polyfill.js";
import "./style.css";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT_ID, NETWORK } from "./config.js";
import { formatUnits, gacha, view } from "./near.js";

const $ = (id) => document.getElementById(id);
const TGAS = 1_000_000_000_000n;

let selector, modal;
let account = null;
let config = null;
let stats = null;
let token = { symbol: "EARN", decimals: 18 };
let current = null; // current batch from the server
let busy = false;

const isOwner = () => Boolean(account && config && account === config.owner_id);
const earn = (raw) => formatUnits(raw, token.decimals, 2);
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function call(methodName, args, { tgas = 30n, deposit = "0" } = {}) {
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: (tgas * TGAS).toString(), deposit } }],
  });
}

// ---------------------------------------------------------------- data

async function refresh() {
  const [s, pool, batchRes] = await Promise.all([
    gacha("get_stats"),
    view(config.token_id, "ft_balance_of", { account_id: CONTRACT_ID }).catch(() => "0"),
    fetch("/api/batch").then((r) => r.json()),
  ]);
  stats = s;
  current = batchRes;
  $("pool").textContent = `${earn(pool)} $${token.symbol}`;
  $("last-batch").textContent = stats.last_batch === null ? "None yet" : label(Number(stats.last_batch));

  // The last 6 closed batches, newest first.
  const ids = Array.from({ length: 6 }, (_, i) => current.batch - 1 - i);
  const rows = await Promise.all(ids.map((id) => fetch(`/api/batches/${id}`).then((r) => r.json())));
  const last = stats.last_batch === null ? -1 : Number(stats.last_batch);
  $("batches").innerHTML = rows
    .map((b) => {
      const drawn = b.batch <= last;
      const can = isOwner() && !drawn && b.entries.length > 0 && !stats.draw_in_progress && !busy;
      const state = drawn ? "Drawn ✓" : b.entries.length ? "Ready" : "No entries";
      return `<div class="batch">
        <div><b>${label(b.batch)}</b><small>${b.entries.length} wallet${b.entries.length === 1 ? "" : "s"} · ${state}</small></div>
        <button class="btn ${can ? "primary" : ""} small" data-batch="${b.batch}" ${can ? "" : "disabled"}>Pull gacha</button>
      </div>`;
    })
    .join("");
  document.querySelectorAll("[data-batch]").forEach((btn) => (btn.onclick = () => pull(Number(btn.dataset.batch))));

  if (isOwner()) {
    $("extra-card").hidden = false;
    const spare = await gacha("get_spare_near");
    $("spare").textContent = formatUnits(spare, 24, 3);
    $("withdraw-btn").disabled = BigInt(spare) === 0n || busy;
  } else {
    $("extra-card").hidden = true;
  }
}

function label(id) {
  const ms = id * current.batch_minutes * 60_000;
  return `${new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })} ${hhmm(ms)}–${hhmm(ms + current.batch_minutes * 60_000)}`;
}

function tick() {
  if (!current) return;
  const left = Math.max(0, Math.floor((current.ends_at - Date.now()) / 1000));
  $("countdown").textContent = `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s`;
  if (left === 0) setTimeout(refresh, 3000);
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `note left ${kind}`;
}

// ---------------------------------------------------------------- actions

async function pull(batch) {
  if (!isOwner()) return;
  busy = true;
  setStatus(`Loading entries for ${label(batch)}…`);
  try {
    const { entries } = await fetch(`/api/batches/${batch}`).then((r) => r.json());
    if (!entries.length) throw new Error("Nobody joined this batch.");
    setStatus(`Confirm in your wallet: draw from ${entries.length} wallets…`);
    await call("draw", { holders: entries, batch: String(batch) }, { tgas: 300n });
    setStatus("Done! Waiting for payouts…", "ok");
    for (let i = 0; i < 10; i++) {
      const [round] = await gacha("get_rounds", { limit: 1 });
      if (round && round.batch !== null && Number(round.batch) === batch) return showResult(round);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    setStatus(e?.message || String(e), "err");
  } finally {
    busy = false;
    await refresh();
  }
}

function showResult(round) {
  $("result-card").hidden = false;
  $("result-title").textContent = `${label(Number(round.batch))} — ${earn(round.prize_pool)} $${token.symbol}`;
  $("result").innerHTML = round.winners.length
    ? round.winners.map((w) => `<li><span>${esc(w.account_id)}</span><b>+${earn(w.amount)}</b></li>`).join("")
    : '<li class="muted">No eligible wallets — pool rolled over.</li>';
  setStatus(`Paid ${round.winners.length} winners.`, "ok");
}

async function withdraw() {
  busy = true;
  setStatus("Confirm the withdrawal in your wallet…");
  try {
    await call("withdraw_near", {}, { tgas: 20n });
    setStatus("Spare NEAR sent to the owner account.", "ok");
  } catch (e) {
    setStatus(e?.message || String(e), "err");
  } finally {
    busy = false;
    await refresh();
  }
}

// ---------------------------------------------------------------- wallet

function showAccount() {
  $("wallet-btn").textContent = account ? `${account} · Sign out` : "Connect wallet";
  $("who").textContent = !account
    ? "Connect the owner wallet (Meteor or HERE). Only the owner can draw — the contract rejects anyone else."
    : isOwner()
      ? `Connected as the owner (${account}). Pick a closed batch and pull.`
      : `${account} is not the owner (${config?.owner_id}). Switch wallets to pull the gacha.`;
}

async function main() {
  if (!CONTRACT_ID) {
    $("who").textContent = "Set VITE_CONTRACT_ID first.";
    return;
  }
  selector = await setupWalletSelector({ network: NETWORK, modules: [setupMeteorWallet(), setupHereWallet()] });
  modal = setupModal(selector, { contractId: CONTRACT_ID });
  account = selector.store.getState().accounts.find((a) => a.active)?.accountId || null;
  selector.store.observable.subscribe(async (state) => {
    const next = state.accounts.find((a) => a.active)?.accountId || null;
    if (next === account) return;
    account = next;
    showAccount();
    if (config) await refresh();
  });
  $("wallet-btn").onclick = async () => (account ? (await selector.wallet()).signOut() : modal.show());
  $("withdraw-btn").onclick = withdraw;

  try {
    config = await gacha("get_config");
    const meta = await view(config.token_id, "ft_metadata").catch(() => null);
    if (meta) token = { symbol: meta.symbol, decimals: meta.decimals };
  } catch {
    $("who").textContent = `Contract ${CONTRACT_ID} isn't live yet.`;
    return;
  }
  showAccount();
  await refresh();
  setInterval(() => !busy && refresh(), 20_000);
  setInterval(tick, 1000);
}

main();
