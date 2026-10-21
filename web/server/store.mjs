// Distribution rounds, saved to DATA_DIR/rounds.json.
// On Railway, mount a volume at DATA_DIR so history survives redeploys.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const FILE = join(DATA_DIR, "rounds.json");
mkdirSync(DATA_DIR, { recursive: true });

let data = { rounds: [], lastSlot: null };
if (existsSync(FILE)) {
  try {
    data = { ...data, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch (e) {
    console.error("Could not read rounds.json:", e.message);
  }
}

function save() {
  writeFileSync(FILE + ".tmp", JSON.stringify(data));
  renameSync(FILE + ".tmp", FILE);
}

export const rounds = () => data.rounds;
export const lastSlot = () => data.lastSlot;

export function addRound(round, slot) {
  data.rounds.push(round);
  if (slot !== undefined) data.lastSlot = slot;
  save();
}

export function updateRound(id, patch) {
  const r = data.rounds.find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  save();
}

/** Totals for one account across all rounds. */
export function earningsOf(account) {
  let total = 0n;
  const history = [];
  for (const r of data.rounds) {
    const p = r.payouts.find((x) => x[0] === account);
    if (p && p[2]) {
      total += BigInt(p[1]);
      history.push({ round: r.id, at: r.finished_at || r.started_at, amount: p[1] });
    }
  }
  return { total: total.toString(), history: history.reverse().slice(0, 20) };
}

export function setLastSlot(slot) {
  data.lastSlot = slot;
  save();
}
