export const NETWORK = import.meta.env.VITE_NETWORK || "mainnet";
export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || "";

/** The $EARN token contract (CA). */
export const TOKEN_ID = import.meta.env.VITE_TOKEN_ID || "earn.v2-launchpad.justhoot.near";

/** NEAR RPC endpoints, tried in order until one answers. */
export const RPC_URLS = [
  ...(import.meta.env.VITE_RPC_URL ? [import.meta.env.VITE_RPC_URL] : []),
  ...(NETWORK === "mainnet"
    ? ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org", "https://near.lava.build"]
    : ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]),
];
export const EXPLORER_URL =
  NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

