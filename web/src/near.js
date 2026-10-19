import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT_ID, NETWORK, RPC_URL, TGAS } from "./config.js";

/** Read-only contract call over JSON-RPC (no wallet needed). */
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

let selector;
let modal;

export async function initWallet(onChange) {
  selector = await setupWalletSelector({
    network: NETWORK,
    modules: [setupMeteorWallet(), setupHereWallet(), setupMyNearWallet()],
  });
  modal = setupModal(selector, { contractId: CONTRACT_ID });
  selector.store.observable.subscribe((state) => {
    onChange(state.accounts.find((a) => a.active)?.accountId || null);
  });
  return selector.store.getState().accounts.find((a) => a.active)?.accountId || null;
}

export const signIn = () => modal.show();
export async function signOut() {
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/** Calls a change method on the gacha contract. */
export async function call(method, args = {}, { tgas = 50n, deposit = 0n } = {}) {
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: method,
          args,
          gas: (tgas * TGAS).toString(),
          deposit: deposit.toString(),
        },
      },
    ],
  });
}

const YOCTO = 10n ** 24n;
export const NEAR = (n) => BigInt(Math.round(n * 1e6)) * (YOCTO / 1_000_000n);

/** yoctoNEAR string -> "12.3456" */
export function formatNear(yocto, digits = 4) {
  return formatUnits(yocto, 24, digits);
}

export function formatUnits(raw, decimals, digits = 2) {
  const v = BigInt(raw || 0);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
