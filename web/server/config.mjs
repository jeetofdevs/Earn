// Settings from environment variables (Railway "Variables" or web/.env).
import { existsSync, readFileSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const env = process.env;
const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const NETWORK = env.VITE_NETWORK || env.NEAR_NETWORK || "mainnet";
export const PORT = Number(env.PORT || 3000);
export const DATA_DIR = env.DATA_DIR || new URL("../data/", import.meta.url).pathname;

/** The $EARN token. */
export const TOKEN_ID = env.VITE_TOKEN_ID || env.TOKEN_ID || "earn.v2-launchpad.justhoot.near";
/** Wallet that collects the tax fees and pays holders. Its key signs payouts. */
export const FEE_WALLET = (env.FEE_WALLET || env.OWNER_ACCOUNT_ID || "").toLowerCase();
export const FEE_WALLET_PRIVATE_KEY = env.FEE_WALLET_PRIVATE_KEY || env.OWNER_PRIVATE_KEY || "";

/** Distribute automatically on this schedule (hours). */
export const AUTO_DISTRIBUTE = env.AUTO_DISTRIBUTE === "true";
export const DISTRIBUTE_HOURS = Number(env.DISTRIBUTE_HOURS || 24);
export const INTERVAL_MS = DISTRIBUTE_HOURS * 3_600_000;

/** Holders need at least this many whole $EARN to get a share. */
export const MIN_HOLD = env.MIN_HOLD || "0";
/** Payouts smaller than this many whole $EARN are skipped (stay for next round). */
export const MIN_PAYOUT = env.MIN_PAYOUT || "0.01";
/** $EARN (whole tokens) to always keep in the fee wallet. */
export const KEEP_IN_WALLET = env.KEEP_IN_WALLET || "0";
/** Most holders paid per round (largest first), to cap gas. */
export const MAX_RECIPIENTS = Number(env.MAX_RECIPIENTS || 5000);

/** Never paid: pools, launchpad, exchanges, team wallets. Comma separated. */
export const EXCLUDE = new Set([TOKEN_ID, FEE_WALLET, ...list(env.EXCLUDE)].filter(Boolean));

/** Password for the /owner page (manual distribution). */
export const ADMIN_PASSWORD = env.ADMIN_PASSWORD || "";
export const NEARBLOCKS_API_KEY = env.NEARBLOCKS_API_KEY || "";

export const RPC_URLS = [
  ...(env.NEAR_RPC_URL ? [env.NEAR_RPC_URL] : []),
  ...(NETWORK === "mainnet"
    ? ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org", "https://near.lava.build"]
    : ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]),
];
export const NEARBLOCKS_URL =
  env.NEARBLOCKS_URL || (NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io");
export const FASTNEAR_URL =
  env.FASTNEAR_URL || (NETWORK === "mainnet" ? "https://api.fastnear.com" : "https://test.api.fastnear.com");
