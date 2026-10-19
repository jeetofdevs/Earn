<p align="center"><img src="brand/logo-512.png" width="140" alt="EARN logo"></p>

# EARN — Holder Gacha on NEAR

**100% of creator fees, paid in $EARN, to 10 random holders every 30 minutes.**

**$EARN CA:** `earn.v2-launchpad.justhoot.near` (NEAR mainnet)

1. **Hold $EARN.**
2. **Submit your wallet address** on the website. No wallet connect, nothing to sign. Do it once per batch.
3. **Every 30 minutes** the batch closes and the gacha is pulled: 10 random wallets from that batch split the whole $EARN prize pool.

> 🇮🇩 **Ringkasnya:** Holder cukup pegang $EARN dan submit alamat wallet di
> website setiap batch (30 menit). Tidak perlu connect wallet. Saat batch
> tutup, kontrak memilih 10 wallet acak dari batch itu, mengecek saldo $EARN
> mereka on-chain, lalu membagi rata 100% fee (dalam $EARN) ke pemenang.
> Hanya owner yang bisa menarik gacha — manual lewat `npm run draw`, atau
> otomatis tiap 30 menit dengan `AUTO_DRAW=true`.

## What's in here

| Folder        | What it is |
|---------------|------------|
| `contract/`   | Rust NEAR smart contract (near-sdk 5) with unit tests |
| `web/`        | Website + Node server: join form, 30-minute batches, auto-draw, draw CLI |
| `brand/`      | Logo (SVG/PNG) and Twitter/X cover (1500×500) |

## How it works

**Fees.** 100% of creator fees go to the contract as $EARN (plain `ft_transfer`
or `ft_transfer_call`). The prize pool is simply the contract's $EARN balance.
If your launchpad pays fees in NEAR, use `withdraw_near`, buy $EARN, and send
it to the contract.

**Joining.** The website's server keeps one list per 30-minute batch. When
someone submits an address it checks `ft_balance_of` on the token and only
accepts holders with at least `min_hold`. Entries are public at
`/api/batches/<id>`.

**Drawing.** Only the owner can call `draw(holders, batch)`. The contract:

1. reads its own $EARN balance (the pool),
2. picks 10 distinct accounts from the list with NEAR's block random seed
   (skipping duplicates, excluded accounts, and itself),
3. re-checks each pick's $EARN balance on the token contract,
4. sends `pool / qualified` $EARN to each pick still holding `min_hold`.

Picks below the minimum get nothing and their share goes to the others. Failed
transfers stay in the pool. Each round stores the batch number and a sha256
hash of the list it drew from, so anyone can check it against `/api/batches/<id>`.

### Contract methods

| Method | Who | Notes |
|---|---|---|
| `new(owner_id, token_id, min_hold, winners_per_draw?)` | deploy | `winners_per_draw` defaults to 10 |
| `draw(holders, batch?)` | owner | attach 300 Tgas; max 5,000 accounts; each batch once |
| `ft_on_transfer` | token | accepts $EARN into the pool, returns other tokens |
| `withdraw_near(amount?)` | owner | spare NEAR only (keeps 0.5 NEAR reserve + storage) |
| `add_excluded`, `remove_excluded` | owner | e.g. liquidity pools, exchanges, team wallets |
| `cancel_pending_draw` | owner | unlocks a draw whose callbacks never ran |
| `set_min_hold`, `set_winners_per_draw`, `transfer_ownership` | owner | |
| `get_config`, `get_stats`, `get_rounds`, `get_pending_draw`, `get_excluded`, `get_spare_near` | view | |

## 1. Deploy the contract (mainnet, near-cli-rs)

```bash
cd contract
cargo test                                # 16 unit tests
cargo near build non-reproducible-wasm    # needs: cargo install cargo-near

near account create-account fund-myself gacha.YOUR-TOKEN.near '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as YOUR-TOKEN.near network-config mainnet sign-with-keychain send

near contract deploy gacha.YOUR-TOKEN.near use-file target/near/earn_gacha.wasm \
  with-init-call new json-args '{
    "owner_id": "YOU.near",
    "token_id": "earn.v2-launchpad.justhoot.near",
    "min_hold": "1000000000000000000000"
  }' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
```

- `min_hold` is in the token's smallest unit (example = 1,000 tokens with 18 decimals).
- Keep at least 1 NEAR on the contract account for storage and gas.
- **Register the contract on the $EARN token** so it can receive $EARN:
  `near contract call-function as-transaction earn.v2-launchpad.justhoot.near storage_deposit json-args '{"account_id":"gacha.YOUR-TOKEN.near"}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' ...`
- Exclude pools/exchanges: `add_excluded '{"account_ids":["pool.ref-finance.near"]}'`.
- Point your creator fees at `gacha.YOUR-TOKEN.near`.

## 2. Deploy the website on Railway

The repo has a `Dockerfile` and `railway.json` at the root (and a root
`package.json` in case Railway uses Railpack instead).

1. Railway → **New Project → Deploy from GitHub repo** → this repo. Leave **Root Directory** empty.
2. **Variables:**
   - `VITE_NETWORK` = `mainnet`
   - `DATA_DIR` = `/data`
   - `MIN_HOLD` = minimum $EARN to join before the contract is live (`0` = any balance)
   - `VITE_CONTRACT_ID` = your gacha contract, once deployed. Leave it unset
     until then: joining is already open and every batch is saved.
   - for auto-draw: `AUTO_DRAW` = `true`, `OWNER_ACCOUNT_ID`, `OWNER_PRIVATE_KEY`
3. **Add a Volume** mounted at `/data`, so batch entries survive redeploys.
4. **Settings → Networking → Generate Domain.**

## 3. Pull the gacha

**Owner page (wallet connect, no private key on the server):** open
`https://<your-site>/owner`. It isn't linked anywhere and is hidden from search
engines. Connect the owner wallet (Meteor or HERE), pick a closed batch and
click **Pull gacha**. Anyone else who finds the page can't draw, because the
contract only accepts `draw` from the owner. You can also withdraw spare NEAR
there.

**Automatic:** with `AUTO_DRAW=true` the server draws each batch about 15–35
seconds after it closes. Empty batches are skipped.

**Manual** (from your computer):

```bash
cd web
cp .env.example .env     # set VITE_*, OWNER_*, SITE_URL=<your Railway URL>
npm install
npm run draw -- --dry-run   # show the batch that just closed
npm run draw                # draw it and pay winners
npm run draw -- --batch 995792
```

A batch can't be drawn twice: the contract rejects a batch number that isn't
newer than the last one drawn.

## Local development

```bash
cd web
npm install
npm run build && npm start   # site + API on http://localhost:3000
npm run dev                  # Vite dev server, /api proxied to :3000
```

## Things to know

- **Your private key** (`OWNER_PRIVATE_KEY`) controls the draws. Keep it only in
  Railway Variables or your local `.env`, never in git. Consider a dedicated
  owner account holding little NEAR.
- **Trust:** the owner sends the batch list to the contract. The list's hash is
  stored on-chain and the list is public, so people can check their address
  was included. The contract picks the winners, not the owner.
- **Randomness** comes from NEAR's block random seed. It's fine for a community
  raffle, but a block producer could in theory influence it.
- Without a Railway volume, batch entries are lost on each redeploy.
- Not audited. Get a review before putting serious money in it.
