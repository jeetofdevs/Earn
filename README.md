<p align="center"><img src="brand/logo-512.png" width="120" alt="EARN logo"></p>

# EARN — 100% of tax fees to holders, on NEAR

**$EARN CA:** `earn.v2-launchpad.justhoot.near` (NEAR mainnet)

Every $EARN trade pays a tax fee. All of it goes to the **fee wallet**, and on a
schedule the server pays it out to **every holder, pro-rata to their balance**,
in $EARN. Holders do nothing: no sign-up, no claiming, no wallet connect.

> 🇮🇩 **Ringkasnya:** semua tax fee $EARN masuk ke fee wallet. Setiap jadwal
> (default 24 jam) server membagikan seluruh isinya ke semua holder sesuai
> persentase kepemilikan mereka. Holder tidak perlu melakukan apa-apa.

## How a payout works

1. **Pool** = the fee wallet's $EARN balance (minus `KEEP_IN_WALLET`).
2. **Holders** are listed from NearBlocks (FastNEAR as backup), then **every balance is re-read on-chain**.
3. Skipped: the token contract, the fee wallet, anything in `EXCLUDE` (pools, launchpad, exchanges, team), and balances under `MIN_HOLD`.
4. **Share** = `pool × your balance ÷ total eligible balance`. Shares under `MIN_PAYOUT` stay for next round.
5. Paid with `ft_transfer` from the fee wallet, 25 holders per transaction. A failed batch stays in the pool.
6. Each round is saved and shown on the site with a full payout list (`/api/rounds/<id>`) and transaction links.

## What's in here

| Folder | What it is |
|---|---|
| `web/` | Website + Node server (payouts, schedule, API, hidden `/owner` page) |
| `brand/` | Logo, Twitter cover, launch post images |

## Deploy on Railway

The repo root has a `Dockerfile`, `railway.json`, and a root `package.json` (for Railpack).

1. **New Project → Deploy from GitHub repo**, Root Directory empty.
2. **Add a Volume** at `/data` (keeps payout history across redeploys).
3. **Variables** (see `web/.env.example` for all of them):
   - `FEE_WALLET` = the wallet that receives the tax fees
   - `FEE_WALLET_PRIVATE_KEY` = its private key (`ed25519:…`)
   - `AUTO_DISTRIBUTE` = `true`, `DISTRIBUTE_HOURS` = `24`
   - `ADMIN_PASSWORD` = a long password for `/owner`
   - `EXCLUDE` = liquidity pools / launchpad / exchange accounts, comma separated
   - `DATA_DIR` = `/data`, `VITE_NETWORK` = `mainnet`
4. **Settings → Networking → Generate Domain.**

The first automatic payout happens at the next scheduled time after the server starts (not immediately).

### Manual payouts

Open `https://<your-site>/owner` (hidden, not indexed), enter `ADMIN_PASSWORD`,
check the preview, then click **Distribute now**.

From your computer, `cd web && npm run preview` shows the next payout without sending anything.

## Costs

Each `ft_transfer` uses gas paid by the fee wallet (roughly 0.0005 NEAR per
holder). 1,000 holders ≈ 0.5 NEAR per payout, so keep NEAR in the fee wallet and
pick `DISTRIBUTE_HOURS` with that in mind. `MIN_PAYOUT` and `MAX_RECIPIENTS`
also limit cost.

## Local development

```bash
cd web
cp .env.example .env
npm install
npm run build && npm start   # http://localhost:3000
```

## Things to know

- The fee wallet's private key lives on the server. Use a **dedicated fee wallet**, never your main wallet, and never commit `.env`.
- Holder lists come from an indexer. Balances are always re-read on-chain, but a holder the indexer misses won't be paid that round.
- Not audited.
