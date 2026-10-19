import "./polyfill.js";
import "./style.css";
import { CONTRACT_ID, EXPLORER_URL } from "./config.js";
import { call, formatNear, formatUnits, gacha, initWallet, NEAR, signIn, signOut, view } from "./near.js";

const $ = (id) => document.getElementById(id);
const ENTRY_DEPOSIT = NEAR(0.01);

let account = null;
let config = null;
let stats = null;
let token = { symbol: "tokens", decimals: 0 };
let entered = false;
let busy = false;

// ---------------------------------------------------------------- machine

function fillDome() {
  const dome = $("dome");
  const colors = ["#FF6A00", "#FF8A2E", "#FFD3B0", "#141414", "#FFB27A"];
  dome.innerHTML = "";
  for (let i = 0; i < 18; i++) {
    const c = document.createElement("span");
    c.className = "cap";
    c.style.setProperty("--x", `${8 + Math.random() * 74}%`);
    c.style.setProperty("--y", `${30 + Math.random() * 52}%`);
    c.style.setProperty("--c", colors[i % colors.length]);
    c.style.setProperty("--r", `${Math.random() * 360}deg`);
    dome.appendChild(c);
  }
}

function spin(on) {
  $("machine").classList.toggle("spinning", on);
}

// ---------------------------------------------------------------- data

async function loadToken() {
  try {
    const meta = await view(config.token_id, "ft_metadata");
    token = { symbol: meta.symbol, decimals: meta.decimals };
  } catch {
    // Token metadata is optional for display.
  }
  document.querySelectorAll(".sym").forEach((el) => (el.textContent = token.symbol));
  $("min-hold").textContent = formatUnits(config.min_hold, token.decimals);
}

async function refresh() {
  try {
    [stats] = await Promise.all([gacha("get_stats")]);
  } catch (e) {
    $("status").textContent = `Can't reach contract ${CONTRACT_ID}. Is it deployed?`;
    return;
  }
  $("pool").textContent = formatNear(stats.prize_pool, 3);
  $("entrants").textContent = stats.entrants.toLocaleString();
  $("paid").textContent = formatNear(stats.total_paid, 3);
  $("next-at").textContent = new Date(Number(BigInt(stats.next_draw_at) / 1_000_000n)).toLocaleString();

  if (account) await refreshMe();
  await renderRounds();
  updateButtons();
}

async function refreshMe() {
  const [isIn, bal] = await Promise.all([
    gacha("is_entered", { account_id: account }),
    view(config.token_id, "ft_balance_of", { account_id: account }).catch(() => "0"),
  ]);
  entered = isIn;
  const holds = BigInt(bal) >= BigInt(config.min_hold);
  $("me-card").hidden = false;
  $("me-account").textContent = account;
  $("me-balance").textContent = `${formatUnits(bal, token.decimals)} ${token.symbol}`;
  $("me-status").textContent = entered
    ? holds ? "In the raffle ✓" : "Entered, but below minimum — you'd be dropped if picked"
    : holds ? "Eligible — enter now" : `Need ${formatUnits(config.min_hold, token.decimals)} ${token.symbol}`;
  $("leave-btn").hidden = !entered;
}

function secondsLeft() {
  if (!stats) return Infinity;
  return Math.max(0, Math.floor((Number(BigInt(stats.next_draw_at) / 1_000_000n) - Date.now()) / 1000));
}

function tick() {
  const s = secondsLeft();
  if (s === Infinity) return;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  $("countdown").textContent = s === 0 ? "Ready!" : `${h ? h + "h " : ""}${m}m ${String(sec).padStart(2, "0")}s`;
  updateButtons();
}

function updateButtons() {
  const enterBtn = $("enter-btn");
  const pullBtn = $("pull-btn");
  if (!stats) return;

  if (!account) {
    enterBtn.textContent = "Connect to enter";
    enterBtn.disabled = false;
  } else {
    enterBtn.textContent = entered ? "You're in ✓" : "Enter the raffle";
    enterBtn.disabled = entered || busy;
  }

  const isOwner = account && config && account === config.owner_id;
  const ready = (secondsLeft() === 0 || isOwner) && BigInt(stats.prize_pool) > 0n && stats.entrants > 0;
  pullBtn.disabled = !account || !ready || stats.draw_in_progress || busy;
  $("knob").disabled = pullBtn.disabled;

  $("status").textContent = stats.draw_in_progress
    ? "Draw in progress…"
    : stats.entrants === 0
      ? "Waiting for the first holder to enter."
      : BigInt(stats.prize_pool) === 0n
        ? "Pool is empty — waiting for fees."
        : secondsLeft() === 0
          ? "The machine is ready. Anyone can pull!"
          : `${formatNear(stats.prize_pool, 3)} NEAR will be split between ${Math.min(config.winners_per_draw, stats.entrants)} holders.`;
}

// ---------------------------------------------------------------- rounds

const short = (a) => (a.length > 22 ? a.slice(0, 10) + "…" + a.slice(-8) : a);

async function renderRounds() {
  const rounds = await gacha("get_rounds", { limit: 10 });
  const box = $("rounds");
  if (!rounds.length) {
    box.innerHTML = '<p class="muted">No draws yet.</p>';
    return rounds;
  }
  box.innerHTML = rounds
    .map((r) => {
      const when = new Date(Number(BigInt(r.timestamp) / 1_000_000n)).toLocaleString();
      const winners = r.winners
        .map((w) => `<li class="${w.account_id === account ? "me" : ""}"><span>${short(w.account_id)}</span><b>+${formatNear(w.amount, 3)}</b></li>`)
        .join("");
      return `<details ${r === rounds[0] ? "open" : ""}>
        <summary><b>Draw #${r.id + 1}</b><span>${formatNear(r.prize_pool, 3)} NEAR · ${r.winners.length} winners</span><small>${when}</small></summary>
        <ul class="winners">${winners || '<li class="muted">No eligible holders — pool rolled over</li>'}</ul>
        ${r.disqualified.length ? `<p class="muted small">Dropped (sold or check failed): ${r.disqualified.map(short).join(", ")}</p>` : ""}
      </details>`;
    })
    .join("");
  return rounds;
}

function showReveal(round) {
  if (!round) return;
  $("reveal-title").textContent = `Draw #${round.id + 1} — ${formatNear(round.prize_pool, 3)} NEAR`;
  $("reveal-list").innerHTML = round.winners.length
    ? round.winners
        .map((w, i) => `<div class="capsule ${w.account_id === account ? "me" : ""}" style="--d:${i * 0.12}s"><span>${short(w.account_id)}</span><b>+${formatNear(w.amount, 3)} N</b></div>`)
        .join("")
    : '<p class="muted">Nobody picked still held tokens. The pool rolls over to the next draw.</p>';
  $("reveal").hidden = false;
}

// ---------------------------------------------------------------- actions

async function run(label, fn) {
  busy = true;
  updateButtons();
  $("status").textContent = label;
  try {
    return await fn();
  } catch (e) {
    $("status").textContent = e?.message || String(e);
    throw e;
  } finally {
    busy = false;
    await refresh();
  }
}

async function enter() {
  if (!account) return signIn();
  await run("Checking your balance and entering…", () => call("enter", {}, { tgas: 50n, deposit: ENTRY_DEPOSIT }));
}

async function pull() {
  if ($("pull-btn").disabled) return;
  spin(true);
  const before = stats.rounds;
  try {
    await run("Pulling the gacha…", () => call("draw", {}, { tgas: 300n }));
    const rounds = await gacha("get_rounds", { limit: 1 });
    if (rounds[0] && rounds[0].id >= before) showReveal(rounds[0]);
  } finally {
    spin(false);
    fillDome();
  }
}

async function leave() {
  await run("Leaving and refunding your deposit…", () => call("leave", {}, { tgas: 30n }));
}

async function fund(e) {
  e.preventDefault();
  if (!account) return signIn();
  const amount = parseFloat($("fund-amount").value);
  if (!(amount > 0)) return;
  await run("Adding to the pool…", () => call("deposit_fees", {}, { tgas: 10n, deposit: NEAR(amount) }));
  $("fund-amount").value = "";
}

// ---------------------------------------------------------------- boot

async function main() {
  fillDome();
  $("contract-link").innerHTML = `<a href="${EXPLORER_URL}/address/${CONTRACT_ID}" target="_blank" rel="noopener">${CONTRACT_ID}</a>`;

  $("enter-btn").onclick = enter;
  $("pull-btn").onclick = pull;
  $("knob").onclick = pull;
  $("leave-btn").onclick = leave;
  $("fund-form").onsubmit = fund;
  $("reveal-close").onclick = () => ($("reveal").hidden = true);
  $("wallet-btn").onclick = () => (account ? signOut() : signIn());

  account = await initWallet(async (acc) => {
    if (acc === account) return;
    account = acc;
    $("wallet-btn").textContent = acc ? short(acc) + " · Sign out" : "Connect wallet";
    if (!acc) $("me-card").hidden = true;
    if (config) await refresh();
  });
  $("wallet-btn").textContent = account ? short(account) + " · Sign out" : "Connect wallet";

  try {
    config = await gacha("get_config");
  } catch {
    $("status").textContent = `Contract ${CONTRACT_ID} not found on this network. Set VITE_CONTRACT_ID.`;
    return;
  }
  await loadToken();
  await refresh();

  // Coming back from a redirect wallet after pulling: show the result.
  const params = new URLSearchParams(location.search);
  if (params.has("transactionHashes")) {
    history.replaceState({}, "", location.pathname);
    const [last] = await gacha("get_rounds", { limit: 1 });
    if (last && Date.now() - Number(BigInt(last.timestamp) / 1_000_000n) < 5 * 60_000) showReveal(last);
  }

  setInterval(tick, 1000);
  setInterval(refresh, 20_000);
  tick();
}

main();
