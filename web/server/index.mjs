// EARN web server: serves the site, shows fee distributions, and pays
// holders their share of the tax fees on a schedule.
//
//   GET  /api/status             fee pool, next distribution, totals
//   GET  /api/rounds             recent distributions (summaries)
//   GET  /api/rounds/:id         one distribution with every payout
//   GET  /api/holder/:account    a wallet's balance, share and earnings
//   POST /api/admin/plan         preview the next distribution   (x-admin-password)
//   POST /api/admin/distribute   distribute now                  (x-admin-password)

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import {
  ADMIN_PASSWORD, AUTO_DISTRIBUTE, DISTRIBUTE_HOURS, EXCLUDE, FEE_WALLET, INTERVAL_MS, KEEP_IN_WALLET,
  MIN_HOLD, MIN_PAYOUT, PORT, TOKEN_ID,
} from "./config.mjs";
import { distribute, isRunning, plan } from "./distribute.mjs";
import { canSign, isAccountId, parseUnits, tokenInfo, view } from "./near.mjs";
import * as store from "./store.mjs";

const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

const slotOf = (ms = Date.now()) => Math.floor(ms / INTERVAL_MS);
const nextAt = () => (slotOf() + 1) * INTERVAL_MS;

// ---------------------------------------------------------------- cached reads

let poolCache = { at: 0, value: null };
async function pool() {
  if (!FEE_WALLET) return null;
  if (Date.now() - poolCache.at < 20_000) return poolCache.value;
  const { decimals } = await tokenInfo(TOKEN_ID);
  const bal = BigInt(await view(TOKEN_ID, "ft_balance_of", { account_id: FEE_WALLET }));
  const keep = parseUnits(KEEP_IN_WALLET, decimals);
  poolCache = { at: Date.now(), value: (bal > keep ? bal - keep : 0n).toString() };
  return poolCache.value;
}

function summary(r) {
  if (!r) return null;
  const { payouts, batches, ...rest } = r;
  return {
    ...rest,
    paid_count: payouts.filter((p) => p[2]).length,
    top: payouts.filter((p) => p[2]).slice(0, 10).map(([account, amount]) => ({ account, amount })),
    txs: batches.map((b) => b.tx).filter(Boolean),
  };
}

// ---------------------------------------------------------------- API

const hits = new Map();
function limited(req, max) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now);
  hits.set(ip, h);
  return h.length > max;
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

function isAdmin(req) {
  const given = Buffer.from(String(req.headers["x-admin-password"] || ""));
  const want = Buffer.from(ADMIN_PASSWORD);
  return ADMIN_PASSWORD.length >= 8 && given.length === want.length && timingSafeEqual(given, want);
}

async function api(req, res, url) {
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/status") {
    const meta = await tokenInfo(TOKEN_ID);
    const rounds = store.rounds();
    const total = rounds.reduce((s, r) => s + BigInt(r.distributed || 0), 0n);
    return send(res, 200, {
      token_id: TOKEN_ID,
      symbol: meta.symbol,
      decimals: meta.decimals,
      fee_wallet: FEE_WALLET || null,
      pool: await pool().catch(() => null),
      interval_hours: DISTRIBUTE_HOURS,
      min_hold: parseUnits(MIN_HOLD, meta.decimals).toString(),
      min_payout: parseUnits(MIN_PAYOUT, meta.decimals).toString(),
      auto: AUTO_DISTRIBUTE && canSign(),
      next_at: nextAt(),
      running: isRunning(),
      rounds: rounds.length,
      total_distributed: total.toString(),
      last_round: summary(rounds.at(-1)),
    });
  }

  if (req.method === "GET" && p === "/api/rounds") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50);
    return send(res, 200, store.rounds().slice(-limit).reverse().map(summary));
  }

  let m = p.match(/^\/api\/rounds\/(\d+)$/);
  if (req.method === "GET" && m) {
    const r = store.rounds().find((x) => x.id === Number(m[1]));
    if (!r) return send(res, 404, { error: "No such round" });
    return send(res, 200, {
      ...r,
      payouts: r.payouts.map(([account, amount, paid, balance]) => ({ account, amount, paid, balance })),
    });
  }

  m = p.match(/^\/api\/holder\/([^/]+)$/);
  if (req.method === "GET" && m) {
    if (limited(req, 30)) return send(res, 429, { error: "Too many requests. Wait a minute." });
    const account = decodeURIComponent(m[1]).trim().toLowerCase();
    if (!isAccountId(account)) return send(res, 400, { error: "That doesn't look like a NEAR wallet address." });
    const { decimals } = await tokenInfo(TOKEN_ID);
    let balance;
    try {
      balance = BigInt(await view(TOKEN_ID, "ft_balance_of", { account_id: account }));
    } catch {
      return send(res, 502, { error: "Couldn't reach NEAR right now. Try again." });
    }
    const excluded = EXCLUDE.has(account);
    const eligible = !excluded && balance > 0n && balance >= parseUnits(MIN_HOLD, decimals);
    // Estimate: current pool split by last round's total eligible balance.
    const last = store.rounds().at(-1);
    const currentPool = BigInt((await pool().catch(() => null)) || 0);
    const totalBal = BigInt(last?.total_eligible_balance || 0);
    const estimate = eligible && totalBal > 0n ? (currentPool * balance) / (totalBal > balance ? totalBal : balance) : 0n;
    return send(res, 200, {
      account,
      balance: balance.toString(),
      eligible,
      excluded,
      min_hold: parseUnits(MIN_HOLD, decimals).toString(),
      share_pct: totalBal > 0n && eligible ? Number((balance * 1_000_000n) / totalBal) / 10_000 : null,
      estimated_next: estimate.toString(),
      ...store.earningsOf(account),
    });
  }

  if (req.method === "POST" && p.startsWith("/api/admin/")) {
    if (limited(req, 10)) return send(res, 429, { error: "Too many tries. Wait a minute." });
    if (!ADMIN_PASSWORD) return send(res, 503, { error: "Set ADMIN_PASSWORD on the server first." });
    if (!isAdmin(req)) return send(res, 401, { error: "Wrong password." });

    if (p === "/api/admin/plan") {
      const pl = await plan();
      return send(res, 200, { ...pl, payouts: pl.payouts.slice(0, 50), can_send: canSign() });
    }
    if (p === "/api/admin/distribute") {
      if (isRunning()) return send(res, 409, { error: "A distribution is already running." });
      if (!canSign()) return send(res, 400, { error: "Set FEE_WALLET and FEE_WALLET_PRIVATE_KEY on the server." });
      distribute({ by: "owner" }).catch((e) => console.error("Manual distribution failed:", e.message || e));
      return send(res, 202, { started: true });
    }
  }

  send(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------- static files

function serveStatic(req, res, url) {
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  if (existsSync(file + ".html")) file += ".html"; // /owner -> owner.html
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) return send(res, 503, { error: "Site not built. Run npm run build." });
  const cache = file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": cache });
  createReadStream(file).pipe(res);
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------- schedule

async function tick() {
  const slot = slotOf();
  // First start: wait for the next scheduled time instead of paying out at once.
  if (store.lastSlot() === null) return store.setLastSlot(slot);
  if (store.lastSlot() >= slot || isRunning()) return;
  try {
    await distribute({ slot, by: "auto" });
  } catch (e) {
    console.error("Scheduled distribution failed:", e.message || e);
    store.setLastSlot(slot); // try again next slot, not in a loop
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      serveStatic(req, res, url);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "Server error" });
    }
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`EARN on :${PORT} · token ${TOKEN_ID} · fee wallet ${FEE_WALLET || "(not set)"} · every ${DISTRIBUTE_HOURS}h`);
    if (AUTO_DISTRIBUTE) {
      if (!canSign()) console.error("AUTO_DISTRIBUTE needs FEE_WALLET and FEE_WALLET_PRIVATE_KEY.");
      else {
        console.log("Auto distribution on.");
        setInterval(tick, 30_000);
        tick();
      }
    }
  });
