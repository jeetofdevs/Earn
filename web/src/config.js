export const NETWORK = import.meta.env.VITE_NETWORK || "mainnet";
export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || "";

/** The $EARN token contract (CA). */
export const TOKEN_ID = import.meta.env.VITE_TOKEN_ID || "earn.v2-launchpad.justhoot.near";

export const RPC_URL =
  NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org";
export const EXPLORER_URL =
  NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

