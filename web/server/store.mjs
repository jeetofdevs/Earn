// Batch entries, kept in memory and saved to DATA_DIR/batches.json.
// On Railway, mount a volume at DATA_DIR so entries survive redeploys.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const FILE = join(DATA_DIR, "batches.json");
const KEEP_BATCHES = 48 * 14; // two weeks of 30-minute batches

/** @type {Map<number, Map<string, number>>} batch id -> (account -> joined at ms) */
const batches = new Map();
/** @type {Map<number, object>} batch id -> auto-draw status */
const draws = new Map();

mkdirSync(DATA_DIR, { recursive: true });
if (existsSync(FILE)) {
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8"));
    for (const [id, entries] of Object.entries(saved.batches || {})) batches.set(Number(id), new Map(Object.entries(entries)));
    for (const [id, d] of Object.entries(saved.draws || {})) draws.set(Number(id), d);
  } catch (e) {
    console.error("Could not read saved batches:", e.message);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ids = [...batches.keys()].sort((a, b) => b - a);
    for (const id of ids.slice(KEEP_BATCHES)) {
      batches.delete(id);
      draws.delete(id);
    }
    const data = {
      batches: Object.fromEntries([...batches].map(([id, m]) => [id, Object.fromEntries(m)])),
      draws: Object.fromEntries(draws),
    };
    writeFileSync(FILE + ".tmp", JSON.stringify(data));
    renameSync(FILE + ".tmp", FILE);
  }, 250);
}

export function entries(batch) {
  return [...(batches.get(batch)?.keys() || [])];
}

export function count(batch) {
  return batches.get(batch)?.size || 0;
}

export function has(batch, account) {
  return Boolean(batches.get(batch)?.has(account));
}

/** Adds `account` to `batch`. Returns false if it was already in. */
export function add(batch, account) {
  if (!batches.has(batch)) batches.set(batch, new Map());
  const m = batches.get(batch);
  if (m.has(account)) return false;
  m.set(account, Date.now());
  save();
  return true;
}

export const getDraw = (batch) => draws.get(batch);
export function setDraw(batch, status) {
  draws.set(batch, { ...draws.get(batch), ...status, updated_at: Date.now() });
  save();
}
