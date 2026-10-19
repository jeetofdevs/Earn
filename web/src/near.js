import { CONTRACT_ID, RPC_URL } from "./config.js";

/** Read-only contract call over JSON-RPC. No wallet needed. */
export async function view(contractId, method, args = {}) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "earn",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const json = await res.json();
  if (json.error || json.result?.error) {
    throw new Error(json.error?.data || json.result?.error || "RPC error");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result)));
}

export const gacha = (method, args) => view(CONTRACT_ID, method, args);

/** Raw token amount -> "1,234.5" */
export function formatUnits(raw, decimals, digits = 2) {
  const v = BigInt(raw || 0);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
