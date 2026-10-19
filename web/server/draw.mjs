// Pull the EARN gacha for a closed batch, as the owner.
//
//   npm run draw                      draw the batch that just closed
//   npm run draw -- --batch 994512    draw a specific batch
//   npm run draw -- --dry-run         show the entries, don't draw
//
// Needs in web/.env (or the environment): VITE_NETWORK, VITE_CONTRACT_ID,
// OWNER_ACCOUNT_ID, OWNER_PRIVATE_KEY, and SITE_URL (your Railway URL, where
// the batch entries live).

import { batchEnd, batchOf, CONTRACT_ID } from "./config.mjs";
import { batchAlreadyDrawn, gacha, sendDraw, view } from "./near.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes("--dry-run");
const batch = Number(opt("--batch") ?? batchOf() - 1);
const site = (process.env.SITE_URL || "").replace(/\/$/, "");

if (!CONTRACT_ID) fail("Set VITE_CONTRACT_ID to your gacha contract account.");
if (!site) fail("Set SITE_URL to your website URL (e.g. https://earn.up.railway.app).");
if (Date.now() < batchEnd(batch)) fail(`Batch ${batch} is still open until ${new Date(batchEnd(batch)).toLocaleString()}.`);

const res = await fetch(`${site}/api/batches/${batch}`);
if (!res.ok) fail(`Couldn't load batch ${batch} from ${site} (HTTP ${res.status}).`);
const { entries } = await res.json();

const config = await gacha("get_config");
const meta = await view(config.token_id, "ft_metadata").catch(() => ({ symbol: "EARN", decimals: 18 }));
const pool = await view(config.token_id, "ft_balance_of", { account_id: CONTRACT_ID });

console.log(`Batch ${batch} (closed ${new Date(batchEnd(batch)).toLocaleString()})`);
console.log(`Entries:    ${entries.length}`);
console.log(`Prize pool: ${fmt(pool, meta.decimals)} ${meta.symbol}`);
if (!entries.length) fail("Nobody joined this batch.");
if (await batchAlreadyDrawn(batch)) fail(`Batch ${batch} was already drawn.`);
if (dryRun) {
  console.log(entries.join("\n"));
  process.exit(0);
}

const ownerId = process.env.OWNER_ACCOUNT_ID;
const privateKey = process.env.OWNER_PRIVATE_KEY;
if (!ownerId || !privateKey) fail("Set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY.");
if (ownerId !== config.owner_id) fail(`${ownerId} is not the contract owner (${config.owner_id}).`);

console.log("Pulling the gacha…");
const tx = await sendDraw({ ownerId, privateKey, accounts: entries, batch });
console.log(`Transaction: ${tx}`);

const [round] = await gacha("get_rounds", { limit: 1 });
if (round && Number(round.batch) === batch) {
  console.log(`\nDraw #${round.id + 1}: ${fmt(round.prize_pool, meta.decimals)} ${meta.symbol}`);
  for (const w of round.winners) console.log(`  🎉 ${w.account_id}  +${fmt(w.amount, meta.decimals)}`);
  if (round.disqualified.length) console.log(`  Below minimum: ${round.disqualified.join(", ")}`);
  if (round.failed_payouts.length) console.log(`  Transfer failed (kept in pool): ${round.failed_payouts.join(", ")}`);
}

function fmt(raw, decimals) {
  const v = BigInt(raw || 0), base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, 2).replace(/0+$/, "");
  return (v / base).toLocaleString("en-US") + (frac ? "." + frac : "");
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
