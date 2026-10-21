export const NETWORK = import.meta.env.VITE_NETWORK || "mainnet";
export const EXPLORER_URL = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
