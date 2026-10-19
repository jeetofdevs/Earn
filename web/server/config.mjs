// Server settings, from environment variables (Railway "Variables").
import { existsSync, readFileSync } from "node:fs";

// Load web/.env for local runs; real env vars win.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const env = process.env;
export const NETWORK = env.VITE_NETWORK || env.NEAR_NETWORK || "mainnet";
export const CONTRACT_ID = env.VITE_CONTRACT_ID || env.CONTRACT_ID || "";
export const RPC_URL =
  env.NEAR_RPC_URL || (NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
export const PORT = Number(env.PORT || 3000);
export const DATA_DIR = env.DATA_DIR || new URL("../data/", import.meta.url).pathname;

/** Batch length. Everyone who joins inside one window is in that window's draw. */
export const BATCH_MS = Number(env.BATCH_MINUTES || 30) * 60_000;
export const MAX_ENTRIES_PER_BATCH = 5000; // matches the contract's MAX_SNAPSHOT

// Optional: let the server pull the gacha itself when each batch closes.
export const AUTO_DRAW = env.AUTO_DRAW === "true";
export const OWNER_ACCOUNT_ID = env.OWNER_ACCOUNT_ID || "";
export const OWNER_PRIVATE_KEY = env.OWNER_PRIVATE_KEY || "";

export const batchOf = (ms = Date.now()) => Math.floor(ms / BATCH_MS);
export const batchStart = (id) => id * BATCH_MS;
export const batchEnd = (id) => (id + 1) * BATCH_MS;
