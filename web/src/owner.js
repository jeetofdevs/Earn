// Hidden owner page: preview and trigger a fee distribution (password protected).
import "./style.css";
import { formatUnits } from "./near.js";

const $ = (id) => document.getElementById(id);
let token = { symbol: "EARN", decimals: 18 };
const earn = (v) => formatUnits(v, token.decimals, 4);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `note left ${kind}`;
}

async function admin(path) {
  const res = await fetch(path, { method: "POST", headers: { "x-admin-password": $("password").value } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function preview(e) {
  e?.preventDefault();
  setStatus("Reading holders and balances… (can take a minute)");
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    token = { symbol: s.symbol, decimals: s.decimals };
    const p = await admin("/api/admin/plan");
    const sym = `$${token.symbol}`;
    $("plan-stats").innerHTML = `
      <div><span>Pool</span><b>${earn(p.pool)} ${sym}</b></div>
      <div><span>Holders</span><b>${p.holders_eligible} eligible / ${p.holders_found} found</b></div>
      <div><span>Recipients</span><b>${p.recipients} (${p.skipped_dust} too small)</b></div>
      <div><span>Total to send</span><b>${earn(p.total)} ${sym} · ${p.transactions} tx</b></div>`;
    $("plan-list").innerHTML = p.payouts
      .map(([a, amt]) => `<li><span>${esc(a)}</span><b>+${earn(amt)}</b></li>`)
      .join("") || '<li class="muted">Nothing to pay right now.</li>';
    $("plan-card").hidden = false;
    $("send-btn").disabled = !p.recipients || !p.can_send;
    setStatus(
      p.can_send ? `Top ${Math.min(50, p.payouts.length)} shown. Holder list from ${p.source}.` : "Server can't send: set FEE_WALLET_PRIVATE_KEY.",
      p.can_send ? "ok" : "err",
    );
  } catch (err) {
    setStatus(err.message, "err");
  }
}

async function send() {
  if (!confirm("Send the fee pool to holders now?")) return;
  $("send-btn").disabled = true;
  try {
    await admin("/api/admin/distribute");
    setStatus("Distribution started. Watch the public page for the result.", "ok");
  } catch (err) {
    setStatus(err.message, "err");
    $("send-btn").disabled = false;
  }
}

$("login").onsubmit = preview;
$("send-btn").onclick = send;
