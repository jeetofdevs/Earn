<p align="center"><img src="brand/logo-512.png" width="140" alt="EARN logo"></p>

# EARN — Holder Gacha on NEAR

**100% of creator fees → 10 random holders, every draw.**

The launchpad pays the creator 100% of the fees. Here, the creator wallet is a
smart contract, and the website turns it into a gacha machine: each draw picks
10 random token holders and splits the whole prize pool between them.

> 🇮🇩 **Ringkasnya:** 100% fee kreator masuk ke kontrak ini. Setiap draw, mesin
> gacha memilih 10 holder secara acak dan membagi seluruh pool sama rata.
> Holder cukup daftar sekali (deposit 0.01 NEAR, dikembalikan saat keluar).
> Yang sudah jual token akan dicoret saat terpilih, dan bagiannya dibagi ke
> pemenang lain.

## What's in here

| Folder      | What it is |
|-------------|------------|
| `contract/` | Rust NEAR smart contract (near-sdk 5) with unit tests |
| `web/`      | The gacha website (Vite + NEAR Wallet Selector) |
| `brand/`    | Logo (SVG/PNG) and Twitter/X cover (1500×500) |

## How the contract works

1. **Fees in.** Set the contract account as the token's creator/fee wallet, so
   fees land on it directly. Plain NEAR transfers count. `deposit_fees` also
   works if the creator forwards fees by hand.
2. **Enter.** A holder calls `enter` with 0.01 NEAR. The contract asks the token
   contract `ft_balance_of(holder)` and adds them if they hold at least
   `min_hold`. The deposit covers storage and is refunded by `leave`.
3. **Draw.** After `draw_interval_sec`, **anyone** can call `draw` (the owner can
   any time). It picks 10 distinct entrants at random (partial Fisher–Yates on
   NEAR's block random seed) and re-checks each one's token balance.
4. **Pay.** Every pick who still holds gets `pool / qualified` NEAR. Picks who
   sold are removed (deposit refunded) and their share goes to the others.
   If nobody qualifies, the pool rolls over.

The prize pool is the account balance minus storage, entry deposits, a 0.5 NEAR
safety reserve, and any prize locked in a running draw — so entry deposits are
never paid out as prizes.

### Methods

| Method | Who | Notes |
|---|---|---|
| `new(owner_id, token_id, min_hold, draw_interval_sec, winners_per_draw?)` | deploy | `winners_per_draw` defaults to 10 |
| `enter()` | holders | attach 0.01 NEAR, 50 Tgas |
| `leave()` | entrants | refunds 0.01 NEAR |
| `draw()` | anyone after timer, owner any time | attach 300 Tgas |
| `deposit_fees()` | anyone | attach NEAR |
| `cancel_pending_draw()` | owner | unlocks a draw whose callback never ran |
| `set_min_hold`, `set_draw_interval`, `set_winners_per_draw`, `transfer_ownership` | owner | |
| `get_config`, `get_stats`, `get_prize_pool`, `is_entered`, `get_entrants`, `get_rounds`, `get_pending_draw` | view | |

Events are logged as `EVENT_JSON` with standard `earn-gacha` (`enter`, `leave`,
`deposit`, `draw`).

## Build & test

```bash
cd contract
cargo test                      # 13 unit tests
cargo near build non-reproducible-wasm   # needs: cargo install cargo-near
```

Use `cargo near build` for deploys: it produces a wasm that the NEAR runtime
accepts with current Rust versions.

## Deploy (testnet example, near-cli-rs)

```bash
near account create-account sponsor-by-faucet-service earn-gacha.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

near contract deploy earn-gacha.testnet use-file contract/target/near/earn_gacha.wasm \
  with-init-call new json-args '{
    "owner_id": "YOUR_ACCOUNT.testnet",
    "token_id": "YOUR_TOKEN.testnet",
    "min_hold": "1000000000000000000000",
    "draw_interval_sec": "86400"
  }' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

- `min_hold` is in the token's smallest unit (example = 1,000 tokens with 18 decimals).
- `draw_interval_sec`: `86400` = daily draw.
- Fund the account with a bit more than 0.5 NEAR for the reserve.
- Then set `earn-gacha.testnet` as the creator fee wallet on your launchpad.

## Website

```bash
cd web
cp .env.example .env    # set VITE_NETWORK and VITE_CONTRACT_ID
npm install
npm run dev             # local
npm run build           # static files in web/dist → Vercel / Netlify / GitHub Pages
```

### Deploy the website on Railway

The repo root has a `Dockerfile` and `railway.json`, so Railway builds and
serves the site from `web/` automatically.

1. Railway → **New Project → Deploy from GitHub repo** → pick this repo and branch.
2. Leave **Root Directory** empty (the repo root).
3. Under **Variables**, add `VITE_NETWORK` (`testnet` or `mainnet`) and
   `VITE_CONTRACT_ID` (your deployed contract account). They are baked in at
   build time, so redeploy after changing them.
4. **Settings → Networking → Generate Domain**.

## Things to know

- **Randomness** comes from NEAR's block random seed. It's fine for a
  community raffle, but a block producer could in theory influence it. For
  large pools, consider a commit-reveal or VRF upgrade.
- **Fees in NEAR only.** If your launchpad pays creator fees in tokens, swap
  them to NEAR before depositing (or extend the contract with `ft_on_transfer`).
- Holders must hold at draw time, not just at entry — sellers are dropped.
- Not audited. Get a review before putting serious money in it.
