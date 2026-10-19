import "./style.css";
import { CONTRACT_ID, EXPLORER_URL } from "./config.js";
import { formatUnits, gacha, view } from "./near.js";

const $ = (id) => document.getElementById(id);

let config = null;
let stats = null;
let pool = "0";
let token = { symbol: "EARN", decimals: 18 };
let seenRounds = null;
let batch = null; // current batch info from the server
const SAVED_KEY = "earn:account";

function savedAccount() {
  try { return localStorage.getItem(SAVED_KEY) || ""; } catch { return ""; }
}
function saveAccount(a) {
  try { localStorage.setItem(SAVED_KEY, a); } catch { /* private mode */ }
}

const earn = (raw, digits = 2) => formatUnits(raw, token.decimals, digits);
const short = (a) => (a.length > 22 ? a.slice(0, 10) + "…" + a.slice(-8) : a);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

const spin = (on) => $("machine").classList.toggle("spinning", on);

// ---------------------------------------------------------------- data

async function loadToken() {
  try {
    const meta = await view(config.token_id, "ft_metadata");
    token = { symbol: meta.symbol, decimals: meta.decimals };
  } catch {
    // Keep the $EARN defaults if metadata can't be read.
  }
  document.querySelectorAll(".sym").forEach((el) => (el.textContent = `$${token.symbol}`));
  $("min-hold").textContent = earn(config.min_hold);
}

async function refresh() {
  let rounds;
  try {
    [stats, pool, rounds] = await Promise.all([
      gacha("get_stats"),
      view(config.token_id, "ft_balance_of", { account_id: CONTRACT_ID }).catch(() => "0"),
      gacha("get_rounds", { limit: 10 }),
    ]);
  } catch {
    $("status").textContent = `Can't reach contract ${CONTRACT_ID}.`;
    return;
  }
  $("pool").textContent = earn(pool);
  $("paid").textContent = earn(stats.total_paid);
  $("draw-count").textContent = `${stats.rounds} draw${stats.rounds === 1 ? "" : "s"} so far`;

  $("status").textContent = stats.draw_in_progress
    ? "Draw in progress — paying winners…"
    : BigInt(pool) === 0n
      ? "Pool is empty — waiting for fees."
      : `${earn(pool)} $${token.symbol} goes to ${config.winners_per_draw} wallets from this batch when it closes.`;
  spin(stats.draw_in_progress);

  renderRounds(rounds);

  // A new draw landed while the page was open: play the reveal.
  if (seenRounds !== null && stats.rounds > seenRounds && rounds[0]) {
    spin(true);
    setTimeout(() => {
      spin(false);
      fillDome();
      showReveal(rounds[0]);
    }, 1800);
  }
  seenRounds = stats.rounds;
}

// ---------------------------------------------------------------- rounds

function renderRounds(rounds) {
  const box = $("rounds");
  if (!rounds.length) {
    box.innerHTML = '<p class="muted">No draws yet.</p>';
    return;
  }
  box.innerHTML = rounds
    .map((r, idx) => {
      const when = new Date(Number(BigInt(r.timestamp) / 1_000_000n)).toLocaleString();
      const winners = r.winners
        .map((w) => `<li><a href="${EXPLORER_URL}/address/${esc(w.account_id)}" target="_blank" rel="noopener">${esc(short(w.account_id))}</a><b>+${earn(w.amount)}</b></li>`)
        .join("");
      const notes = [
        r.disqualified.length ? `Picked but below the minimum: ${r.disqualified.map((a) => esc(short(a))).join(", ")}` : "",
        r.failed_payouts.length ? `Transfer failed, kept in pool: ${r.failed_payouts.map((a) => esc(short(a))).join(", ")}` : "",
        `Drawn from ${r.snapshot_size.toLocaleString()} wallets${r.batch !== null ? ` · <a href="/api/batches/${Number(r.batch)}" target="_blank" rel="noopener">see entries</a>` : ""} · list hash <code>${esc(r.snapshot_hash.slice(0, 16))}…</code>`,
      ].filter(Boolean).map((t) => `<p class="muted small">${t}</p>`).join("");
      return `<details ${idx === 0 ? "open" : ""}>
        <summary><b>${r.batch !== null ? `Batch ${batchLabel(Number(r.batch))}` : `Draw #${r.id + 1}`}</b><span>${earn(r.prize_pool)} $${token.symbol} · ${r.winners.length} winners</span><small>${when}</small></summary>
        <ul class="winners">${winners || '<li class="muted">No eligible holders — pool rolled over</li>'}</ul>
        ${notes}
      </details>`;
    })
    .join("");
}

function showReveal(round) {
  $("reveal-title").textContent = `Draw #${round.id + 1} — ${earn(round.prize_pool)} $${token.symbol}`;
  $("reveal-list").innerHTML = round.winners.length
    ? round.winners
        .map((w, i) => `<div class="capsule" style="--d:${i * 0.12}s"><span>${esc(short(w.account_id))}</span><b>+${earn(w.amount)}</b></div>`)
        .join("")
    : '<p class="muted">Nobody picked held enough. The pool rolls over to the next draw.</p>';
  $("reveal").hidden = false;
}

// ---------------------------------------------------------------- batches

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const batchLabel = (id) => {
  const minutes = batch?.batch_minutes || 30;
  const start = id * minutes * 60_000;
  return `${new Date(start).toLocaleDateString([], { month: "short", day: "numeric" })} ${hhmm(start)}–${hhmm(start + minutes * 60_000)}`;
};

async function loadBatch() {
  try {
    const q = savedAccount() ? `?account=${encodeURIComponent(savedAccount())}` : "";
    const res = await fetch(`/api/batch${q}`);
    if (!res.ok) throw new Error();
    batch = await res.json();
  } catch {
    batch = null;
    $("countdown").textContent = "—";
    $("join-timer").textContent = "Joining offline";
    return;
  }
  $("batch-entries").textContent = batch.entries.toLocaleString();
  $("batch-time").textContent = `${hhmm(batch.starts_at)}–${hhmm(batch.ends_at)}`;
  if (batch.joined) showJoined(savedAccount());
  tick();
}

function tick() {
  if (!batch) return;
  const left = Math.max(0, Math.floor((batch.ends_at - Date.now()) / 1000));
  const text = `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s`;
  $("countdown").textContent = text;
  $("join-timer").textContent = left ? `Closes in ${text}` : "Drawing…";
  if (left === 0) setTimeout(loadBatch, 3000); // next batch has started
}

function showJoined(account) {
  const out = $("join-result");
  out.hidden = false;
  out.className = "check-result yes";
  out.textContent = `✓ ${account} is in this batch (${hhmm(batch.starts_at)}–${hhmm(batch.ends_at)}). Winners are drawn when it closes — join again next batch!`;
}

async function join(e) {
  e.preventDefault();
  const out = $("join-result");
  const account = $("join-account").value.trim().toLowerCase();
  out.hidden = false;
  out.className = "check-result";
  out.textContent = "Checking your $EARN…";
  $("join-btn").disabled = true;
  try {
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account }),
    });
    const data = await res.json();
    if (res.ok) {
      saveAccount(account);
      batch = { ...batch, ...data };
      $("batch-entries").textContent = data.entries.toLocaleString();
      showJoined(account);
      return;
    }
    out.className = "check-result no";
    out.textContent = data.error === "not_enough"
      ? `✗ ${account} holds ${earn(data.balance)} $${token.symbol}. You need at least ${earn(data.min_hold)} to join.`
      : `✗ ${data.error || "Couldn't join. Try again."}`;
  } catch {
    out.className = "check-result no";
    out.textContent = "✗ Couldn't reach the server. Try again.";
  } finally {
    $("join-btn").disabled = false;
  }
}

// ---------------------------------------------------------------- boot

async function main() {
  fillDome();
  $("contract-link").innerHTML = `<a href="${EXPLORER_URL}/address/${CONTRACT_ID}" target="_blank" rel="noopener">${CONTRACT_ID}</a>`;
  $("join-form").onsubmit = join;
  $("join-account").value = savedAccount();
  $("reveal-close").onclick = () => ($("reveal").hidden = true);

  try {
    config = await gacha("get_config");
  } catch {
    $("status").textContent = `Contract ${CONTRACT_ID} not found on this network. Set VITE_CONTRACT_ID.`;
    return;
  }
  await loadToken();
  await Promise.all([refresh(), loadBatch()]);
  setInterval(refresh, 15_000);
  setInterval(loadBatch, 30_000);
  setInterval(tick, 1000);
}

main();
