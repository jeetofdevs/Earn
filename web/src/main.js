import "./style.css";
import { EXPLORER_URL } from "./config.js";
import { formatUnits } from "./near.js";

const $ = (id) => document.getElementById(id);
const SAVED_KEY = "earn:account";

let status = null;
let token = { symbol: "EARN", decimals: 18 };

const earn = (raw, digits = 2) => formatUnits(raw, token.decimals, digits);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a) => (a.length > 24 ? a.slice(0, 10) + "…" + a.slice(-8) : a);
const when = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function saved() {
  try { return localStorage.getItem(SAVED_KEY) || ""; } catch { return ""; }
}
function save(a) {
  try { localStorage.setItem(SAVED_KEY, a); } catch { /* private mode */ }
}

async function getJson(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- status

async function loadStatus() {
  try {
    status = await getJson("/api/status");
  } catch {
    $("status").textContent = "Can't reach the server right now.";
    return;
  }
  token = { symbol: status.symbol, decimals: status.decimals };
  document.querySelectorAll(".sym").forEach((el) => (el.textContent = `$${token.symbol}`));

  $("pool").textContent = status.pool === null ? "—" : earn(status.pool);
  $("flow-pool").textContent = status.pool === null ? "collecting…" : `${earn(status.pool)} $${token.symbol} ready`;
  $("total").textContent = earn(status.total_distributed);
  $("last-count").textContent = status.last_round ? status.last_round.paid_count.toLocaleString() : "—";
  $("rounds-count").textContent = `${status.rounds} payout${status.rounds === 1 ? "" : "s"} so far`;
  $("next-at").textContent = when(status.next_at);
  const sym = `$${token.symbol}`;
  $("rules").textContent = [
    BigInt(status.min_hold) > 0n ? `Minimum to earn: ${earn(status.min_hold)} ${sym}.` : "Any amount of $EARN earns.",
    `Payouts under ${earn(status.min_payout, 4)} ${sym} roll over to the next round.`,
    "Liquidity pools, the launchpad and the fee wallet don't receive shares.",
  ].join(" ");
  $("flow-every").textContent = status.interval_hours === 1 ? "every hour" : `every ${status.interval_hours}h`;
  if (status.fee_wallet) {
    $("wallet-link").innerHTML = `Fee wallet: <a href="${EXPLORER_URL}/address/${esc(status.fee_wallet)}" target="_blank" rel="noopener">${esc(short(status.fee_wallet))}</a>`;
  }
  $("status").textContent = status.running
    ? "Paying holders right now…"
    : !status.fee_wallet
      ? "Payouts start soon."
      : `Next payout ${when(status.next_at)}.`;
  tick();
}

function tick() {
  if (!status) return;
  const left = Math.max(0, Math.floor((status.next_at - Date.now()) / 1000));
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  $("countdown").textContent = left ? `${h ? h + "h " : ""}${m}m ${String(s).padStart(2, "0")}s` : "Paying…";
  if (left === 0) setTimeout(loadAll, 15_000);
}

// ---------------------------------------------------------------- rounds

async function loadRounds() {
  let rounds;
  try {
    rounds = await getJson("/api/rounds?limit=10");
  } catch {
    return;
  }
  const box = $("rounds");
  if (!rounds.length) {
    box.innerHTML = '<p class="muted">No payouts yet. The first one is on the countdown above.</p>';
    return;
  }
  box.innerHTML = rounds
    .map((r, i) => {
      const top = r.top
        .map((w) => `<li><a href="${EXPLORER_URL}/address/${esc(w.account)}" target="_blank" rel="noopener">${esc(short(w.account))}</a><b>+${earn(w.amount)}</b></li>`)
        .join("");
      const txs = r.txs.slice(0, 3).map((t, n) => `<a href="${EXPLORER_URL}/txns/${esc(t)}" target="_blank" rel="noopener">tx ${n + 1}</a>`).join(" · ");
      return `<details ${i === 0 ? "open" : ""}>
        <summary><b>Payout #${r.id}</b><span>${earn(r.distributed)} $${token.symbol} · ${r.paid_count.toLocaleString()} holders</span><small>${when(r.finished_at || r.started_at)}</small></summary>
        <ul class="winners">${top || `<li class="muted">${esc(r.note || "Nothing paid this round")}</li>`}</ul>
        <p class="muted small">Top 10 shown · <a href="/api/rounds/${r.id}" target="_blank" rel="noopener">full list</a>${txs ? " · " + txs : ""}${r.failed !== "0" ? ` · ${earn(r.failed)} $${token.symbol} failed and stays for next round` : ""}</p>
      </details>`;
    })
    .join("");
}

// ---------------------------------------------------------------- checker

async function check(e) {
  e?.preventDefault();
  const account = $("check-account").value.trim().toLowerCase();
  const out = $("check-result");
  if (!account) return;
  out.hidden = false;
  out.innerHTML = '<p class="check-result">Checking…</p>';
  $("check-btn").disabled = true;
  try {
    const h = await getJson(`/api/holder/${encodeURIComponent(account)}`);
    save(account);
    const sym = `$${token.symbol}`;
    const status = h.excluded
      ? `<p class="check-result no">This address is excluded (pool, launchpad or fee wallet).</p>`
      : h.eligible
        ? `<p class="check-result yes">✓ You're earning. Keep holding — your share is paid automatically.</p>`
        : `<p class="check-result no">✗ ${BigInt(h.min_hold) > 0n ? `Hold at least ${earn(h.min_hold)} ${sym} to earn.` : `Hold some ${sym} to earn.`}</p>`;
    const history = h.history.length
      ? `<ul class="winners">${h.history.map((x) => `<li><span>Payout #${x.round} · ${when(x.at)}</span><b>+${earn(x.amount)}</b></li>`).join("")}</ul>`
      : "";
    out.innerHTML = `
      ${status}
      <div class="me">
        <div><span>Your balance</span><b>${earn(h.balance)} ${sym}</b></div>
        <div><span>Your share</span><b>${h.share_pct === null ? "—" : `${h.share_pct.toLocaleString(undefined, { maximumFractionDigits: 4 })}%`}</b></div>
        <div><span>Est. next payout</span><b>${h.eligible ? `~${earn(h.estimated_next, 4)} ${sym}` : "—"}</b></div>
        <div><span>Total received</span><b>${earn(h.total)} ${sym}</b></div>
      </div>
      ${history}`;
  } catch (err) {
    out.innerHTML = `<p class="check-result no">✗ ${esc(err.message)}</p>`;
  } finally {
    $("check-btn").disabled = false;
  }
}

// ---------------------------------------------------------------- boot

async function loadAll() {
  await loadStatus();
  await loadRounds();
}

async function main() {
  $("check-form").onsubmit = check;
  $("check-account").value = saved();
  await loadAll();
  if (saved()) check();
  setInterval(loadAll, 30_000);
  setInterval(tick, 1000);
}

main();
