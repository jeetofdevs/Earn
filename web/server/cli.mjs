// Preview the next distribution from your computer (sends nothing).
//   npm run preview
import { formatUnits, tokenInfo } from "./near.mjs";
import { plan } from "./distribute.mjs";
import { TOKEN_ID } from "./config.mjs";

const p = await plan();
const { symbol, decimals } = await tokenInfo(TOKEN_ID);
const f = (v) => `${formatUnits(v, decimals)} ${symbol}`;
console.log(`Pool:        ${f(p.pool)}`);
console.log(`Holders:     ${p.holders_found} found (${p.source}), ${p.holders_eligible} eligible`);
console.log(`Recipients:  ${p.recipients} (${p.skipped_dust} below the minimum payout)`);
console.log(`Total:       ${f(p.total)} in ${p.transactions} transaction(s)\n`);
for (const [a, amt] of p.payouts.slice(0, 25)) console.log(`  ${a.padEnd(40)} ${f(amt)}`);
if (p.payouts.length > 25) console.log(`  … and ${p.payouts.length - 25} more`);
