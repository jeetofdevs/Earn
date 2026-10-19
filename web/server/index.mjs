// EARN web server: serves the site and runs the 30-minute join batches.
//
//   GET  /api/batch?account=x   current batch: id, start/end, entries, joined?
//   POST /api/join {account}    join the current batch (must hold min $EARN)
//   GET  /api/batches/:id       everyone who joined a batch (public, for audits)
//
// With AUTO_DRAW=true and owner keys set, it also pulls the gacha for each
// batch right after it closes.

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import {
  AUTO_DRAW, BATCH_MS, CONTRACT_ID, MAX_ENTRIES_PER_BATCH, OWNER_ACCOUNT_ID, OWNER_PRIVATE_KEY, PORT,
  batchEnd, batchOf, batchStart,
} from "./config.mjs";
import { batchAlreadyDrawn, gacha, isAccountId, sendDraw, view } from "./near.mjs";
import * as store from "./store.mjs";

const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

// ---------------------------------------------------------------- contract config (cached)

let cfg = null;
let cfgAt = 0;
async function contractConfig() {
  if (!cfg || Date.now() - cfgAt > 60_000) {
    cfg = await gacha("get_config");
    cfgAt = Date.now();
  }
  return cfg;
}

// ---------------------------------------------------------------- rate limit

const hits = new Map();
function limited(ip, max = 20) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now);
  hits.set(ip, h);
  return h.length > max;
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

// ---------------------------------------------------------------- API

function batchInfo(id, account) {
  return {
    batch: id,
    starts_at: batchStart(id),
    ends_at: batchEnd(id),
    batch_minutes: BATCH_MS / 60_000,
    entries: store.count(id),
    joined: account ? store.has(id, account) : undefined,
    previous: { batch: id - 1, entries: store.count(id - 1), draw: store.getDraw(id - 1) || null },
  };
}

async function join_(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  if (limited(ip)) return send(res, 429, { error: "Too many tries. Wait a minute." });

  const body = await readJson(req).catch(() => null);
  const account = String(body?.account || "").trim().toLowerCase();
  if (!isAccountId(account)) return send(res, 400, { error: "That doesn't look like a NEAR wallet address." });
  if (CONTRACT_ID && account === CONTRACT_ID) return send(res, 400, { error: "That's the gacha contract." });

  if (!CONTRACT_ID) return send(res, 503, { error: "EARN Gacha will be live soon." });
  const batch = batchOf();
  if (store.has(batch, account)) return send(res, 200, { ok: true, already: true, ...batchInfo(batch, account) });
  if (store.count(batch) >= MAX_ENTRIES_PER_BATCH) return send(res, 409, { error: "This batch is full. Try the next one." });

  let config, balance;
  try {
    config = await contractConfig();
    balance = await view(config.token_id, "ft_balance_of", { account_id: account });
  } catch {
    return send(res, 502, { error: "Couldn't reach NEAR right now. Try again." });
  }
  if (BigInt(balance) < BigInt(config.min_hold)) {
    return send(res, 403, { error: "not_enough", balance, min_hold: config.min_hold });
  }

  store.add(batch, account);
  send(res, 200, { ok: true, balance, ...batchInfo(batch, account) });
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/batch") {
    const account = url.searchParams.get("account")?.toLowerCase();
    return send(res, 200, batchInfo(batchOf(), account));
  }
  if (req.method === "POST" && url.pathname === "/api/join") return join_(req, res);

  const m = url.pathname.match(/^\/api\/batches\/(\d+)$/);
  if (req.method === "GET" && m) {
    const id = Number(m[1]);
    return send(res, 200, {
      batch: id,
      starts_at: batchStart(id),
      ends_at: batchEnd(id),
      closed: Date.now() >= batchEnd(id),
      entries: store.entries(id),
      draw: store.getDraw(id) || null,
    });
  }
  send(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------- static files

function serveStatic(req, res, url) {
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) return send(res, 503, { error: "Site not built. Run npm run build." });
  const type = TYPES[extname(file)] || "application/octet-stream";
  const cache = file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- helpers

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- auto draw

async function autoDrawTick() {
  const batch = batchOf() - 1; // the batch that just closed
  const status = store.getDraw(batch);
  if (status?.state === "done" || status?.state === "skipped" || status?.state === "running") return;
  if ((status?.attempts || 0) >= 3) return;
  if (Date.now() < batchEnd(batch) + 15_000) return; // small grace period

  const accounts = store.entries(batch);
  if (!accounts.length) return store.setDraw(batch, { state: "skipped", reason: "no entries" });

  try {
    if (await batchAlreadyDrawn(batch)) return store.setDraw(batch, { state: "done", by: "owner" });
    store.setDraw(batch, { state: "running", attempts: (status?.attempts || 0) + 1 });
    const tx = await sendDraw({ ownerId: OWNER_ACCOUNT_ID, privateKey: OWNER_PRIVATE_KEY, accounts, batch });
    store.setDraw(batch, { state: "done", tx });
    console.log(`Batch ${batch}: drew from ${accounts.length} entries, tx ${tx}`);
  } catch (e) {
    store.setDraw(batch, { state: "error", error: String(e.message || e).slice(0, 300) });
    console.error(`Batch ${batch}: draw failed:`, e.message || e);
  }
}

// ---------------------------------------------------------------- start

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
    console.log(`EARN site on :${PORT} · contract ${CONTRACT_ID || "(VITE_CONTRACT_ID not set)"} · ${BATCH_MS / 60_000}-minute batches`);
    if (AUTO_DRAW) {
      if (!OWNER_ACCOUNT_ID || !OWNER_PRIVATE_KEY) console.error("AUTO_DRAW needs OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY");
      else {
        console.log(`Auto-draw on as ${OWNER_ACCOUNT_ID}`);
        setInterval(autoDrawTick, 20_000);
      }
    }
  });
