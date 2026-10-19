export const NETWORK = import.meta.env.VITE_NETWORK || "mainnet";
export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || "";

export const RPC_URL =
  NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org";
export const EXPLORER_URL =
  NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

