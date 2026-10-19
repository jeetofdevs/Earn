//! Earn Gacha — a NEAR contract that sends 100% of a token's creator fees
//! to 10 random holders.
//!
//! How it works:
//! 1. The launchpad pays creator fees (in NEAR) to this contract's account,
//!    either directly (set this account as the creator wallet) or by the
//!    creator forwarding them with `deposit_fees`.
//! 2. Holders of the project token call `enter`. The contract checks their
//!    balance on the token contract (`ft_balance_of`) and adds them to the
//!    raffle if they hold at least `min_hold`.
//! 3. Once per `draw_interval`, anyone can call `draw`. The contract picks 10
//!    random entrants, re-checks that each one still holds the token, and
//!    splits the whole prize pool equally between the ones that do.
//!    Entrants who sold are removed and their share goes to the others.

use std::collections::HashMap;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseResult,
};

/// Deposit required to join the raffle. Covers storage and is refunded on `leave`.
pub const ENTRY_DEPOSIT: NearToken = NearToken::from_millinear(10); // 0.01 NEAR
/// Balance always kept on the contract for storage and gas, never paid out.
pub const RESERVE: NearToken = NearToken::from_millinear(500); // 0.5 NEAR
pub const DEFAULT_WINNERS: u32 = 10;

const GAS_FOR_BALANCE_CHECK: Gas = Gas::from_tgas(5);
const GAS_FOR_ENTER_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_DRAW_CALLBACK: Gas = Gas::from_tgas(60);

const EVENT_STANDARD: &str = "earn-gacha";
const EVENT_VERSION: &str = "1.0.0";

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Entrants,
    EntrantIndex,
    Rounds,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Winner {
    pub account_id: AccountId,
    pub amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u32,
    pub timestamp: U64,
    pub prize_pool: U128,
    pub entrants: u32,
    pub winners: Vec<Winner>,
    /// Picked accounts that no longer held enough tokens.
    pub disqualified: Vec<AccountId>,
    /// Amount that stayed in the pool (rounding dust, or nobody qualified).
    pub rolled_over: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingDraw {
    pub round_id: u32,
    pub prize: U128,
    pub candidates: Vec<AccountId>,
    pub started_at: U64,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub token_id: AccountId,
    pub min_hold: U128,
    pub winners_per_draw: u32,
    pub draw_interval_sec: U64,
    pub entry_deposit: U128,
    pub reserve: U128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub prize_pool: U128,
    pub entrants: u32,
    pub rounds: u32,
    pub total_paid: U128,
    pub last_draw_at: U64,
    pub next_draw_at: U64,
    pub draw_in_progress: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EarnGacha {
    owner_id: AccountId,
    token_id: AccountId,
    min_hold: u128,
    winners_per_draw: u32,
    draw_interval_ns: u64,
    last_draw_ns: u64,
    entrants: Vector<AccountId>,
    entrant_index: LookupMap<AccountId, u32>,
    /// Entry deposits we owe back to entrants. Never part of the prize pool.
    held_deposits: u128,
    rounds: Vector<Round>,
    pending: Option<PendingDraw>,
    total_paid: u128,
}

#[near]
impl EarnGacha {
    #[init]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        min_hold: U128,
        draw_interval_sec: U64,
        winners_per_draw: Option<u32>,
    ) -> Self {
        let winners = winners_per_draw.unwrap_or(DEFAULT_WINNERS);
        require!(winners > 0 && winners <= 20, "winners_per_draw must be 1..=20");
        Self {
            owner_id,
            token_id,
            min_hold: min_hold.0,
            winners_per_draw: winners,
            draw_interval_ns: draw_interval_sec.0 * 1_000_000_000,
            last_draw_ns: env::block_timestamp(),
            entrants: Vector::new(StorageKey::Entrants),
            entrant_index: LookupMap::new(StorageKey::EntrantIndex),
            held_deposits: 0,
            rounds: Vector::new(StorageKey::Rounds),
            pending: None,
            total_paid: 0,
        }
    }

    // ------------------------------------------------------------------
    // Fees
    // ------------------------------------------------------------------

    /// Add NEAR to the prize pool. Plain transfers to this account also count;
    /// this method only adds a log entry so the website can show who funded it.
    #[payable]
    pub fn deposit_fees(&mut self) {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "Attach NEAR to deposit");
        emit(
            "deposit",
            json!({ "account_id": env::predecessor_account_id(), "amount": U128(amount.as_yoctonear()) }),
        );
    }

    // ------------------------------------------------------------------
    // Entering and leaving
    // ------------------------------------------------------------------

    /// Join the raffle. Attach `ENTRY_DEPOSIT` (0.01 NEAR, refunded on `leave`).
    /// The token balance is checked on the token contract first.
    #[payable]
    pub fn enter(&mut self) -> Promise {
        let account_id = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= ENTRY_DEPOSIT, "Attach 0.01 NEAR to enter");
        require!(!self.entrant_index.contains_key(&account_id), "Already entered");

        // Hold the full deposit until the callback decides; it refunds any excess.
        self.held_deposits += deposit.as_yoctonear();

        ext_ft::ext(self.token_id.clone())
            .with_static_gas(GAS_FOR_BALANCE_CHECK)
            .ft_balance_of(account_id.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ENTER_CALLBACK)
                    .on_enter_checked(account_id, U128(deposit.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_enter_checked(&mut self, account_id: AccountId, deposit: U128) -> bool {
        let balance = read_u128_result(0);
        self.held_deposits -= deposit.0;

        let ok = matches!(balance, Some(b) if b >= self.min_hold)
            && !self.entrant_index.contains_key(&account_id);
        if !ok {
            let _ = Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(deposit.0));
            log!("{} does not hold enough tokens; deposit refunded", account_id);
            return false;
        }

        self.held_deposits += ENTRY_DEPOSIT.as_yoctonear();
        let excess = deposit.0 - ENTRY_DEPOSIT.as_yoctonear();
        if excess > 0 {
            let _ = Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(excess));
        }
        self.add_entrant(account_id.clone());
        emit("enter", json!({ "account_id": account_id, "balance": U128(balance.unwrap_or(0)) }));
        true
    }

    /// Leave the raffle and get the entry deposit back.
    pub fn leave(&mut self) -> Promise {
        let account_id = env::predecessor_account_id();
        require!(self.remove_entrant(&account_id), "Not entered");
        self.held_deposits -= ENTRY_DEPOSIT.as_yoctonear();
        emit("leave", json!({ "account_id": account_id }));
        Promise::new(account_id).transfer(ENTRY_DEPOSIT)
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    /// Pull the gacha. Anyone can call once the draw interval has passed
    /// (the owner can call any time). Attach 300 Tgas.
    pub fn draw(&mut self) -> Promise {
        require!(self.pending.is_none(), "A draw is already in progress");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || now >= self.last_draw_ns + self.draw_interval_ns,
            "Too early: wait for the next draw time"
        );
        let prize = self.prize_pool();
        require!(prize > 0, "Prize pool is empty");
        let n = self.entrants.len();
        require!(n > 0, "No entrants");

        let round_id = self.rounds.len();
        let picks = pick_unique(n, self.winners_per_draw.min(n), &env::random_seed_array(), round_id);
        let candidates: Vec<AccountId> =
            picks.into_iter().map(|i| self.entrants[i].clone()).collect();

        self.pending = Some(PendingDraw {
            round_id,
            prize: U128(prize),
            candidates: candidates.clone(),
            started_at: U64(now),
        });
        self.last_draw_ns = now;

        let checks = candidates
            .iter()
            .map(|a| {
                ext_ft::ext(self.token_id.clone())
                    .with_static_gas(GAS_FOR_BALANCE_CHECK)
                    .ft_balance_of(a.clone())
            })
            .reduce(|a, b| a.and(b))
            .expect("at least one candidate");

        checks.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_DRAW_CALLBACK)
                .on_draw_checked(),
        )
    }

    /// Pays every candidate that still holds enough tokens. Written so it
    /// cannot panic: a stuck draw would lock the pool.
    #[private]
    pub fn on_draw_checked(&mut self) -> Round {
        let pending = self.pending.take().expect("No pending draw");
        let prize = pending.prize.0;

        let mut qualified = Vec::new();
        let mut disqualified = Vec::new();
        for (i, account_id) in pending.candidates.iter().enumerate() {
            match read_u128_result(i as u64) {
                Some(b) if b >= self.min_hold => qualified.push(account_id.clone()),
                Some(_) => {
                    // Sold their tokens: remove them and refund their entry deposit.
                    if self.remove_entrant(account_id) {
                        self.held_deposits -= ENTRY_DEPOSIT.as_yoctonear();
                        let _ = Promise::new(account_id.clone()).transfer(ENTRY_DEPOSIT);
                    }
                    disqualified.push(account_id.clone());
                }
                // Token contract call failed: skip this round, keep them entered.
                None => disqualified.push(account_id.clone()),
            }
        }

        let mut winners = Vec::new();
        let mut paid = 0u128;
        if !qualified.is_empty() {
            let share = prize / qualified.len() as u128;
            if share > 0 {
                for account_id in qualified {
                    let _ = Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(share));
                    paid += share;
                    winners.push(Winner { account_id, amount: U128(share) });
                }
            }
        }
        self.total_paid += paid;

        let round = Round {
            id: pending.round_id,
            timestamp: pending.started_at,
            prize_pool: U128(prize),
            entrants: self.entrants.len(),
            winners,
            disqualified,
            rolled_over: U128(prize - paid),
        };
        self.rounds.push(round.clone());
        emit("draw", json!(round));
        round
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// Clears a draw whose callback never ran. The prize was never sent,
    /// so it simply returns to the pool.
    pub fn cancel_pending_draw(&mut self) {
        self.assert_owner();
        require!(self.pending.take().is_some(), "No pending draw");
    }

    pub fn set_min_hold(&mut self, min_hold: U128) {
        self.assert_owner();
        self.min_hold = min_hold.0;
    }

    pub fn set_draw_interval(&mut self, draw_interval_sec: U64) {
        self.assert_owner();
        self.draw_interval_ns = draw_interval_sec.0 * 1_000_000_000;
    }

    pub fn set_winners_per_draw(&mut self, winners_per_draw: u32) {
        self.assert_owner();
        require!(winners_per_draw > 0 && winners_per_draw <= 20, "winners_per_draw must be 1..=20");
        self.winners_per_draw = winners_per_draw;
    }

    pub fn transfer_ownership(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        self.owner_id = new_owner_id;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            token_id: self.token_id.clone(),
            min_hold: U128(self.min_hold),
            winners_per_draw: self.winners_per_draw,
            draw_interval_sec: U64(self.draw_interval_ns / 1_000_000_000),
            entry_deposit: U128(ENTRY_DEPOSIT.as_yoctonear()),
            reserve: U128(RESERVE.as_yoctonear()),
        }
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            prize_pool: U128(self.prize_pool()),
            entrants: self.entrants.len(),
            rounds: self.rounds.len(),
            total_paid: U128(self.total_paid),
            last_draw_at: U64(self.last_draw_ns),
            next_draw_at: U64(self.last_draw_ns + self.draw_interval_ns),
            draw_in_progress: self.pending.is_some(),
        }
    }

    /// NEAR available to win right now.
    pub fn get_prize_pool(&self) -> U128 {
        U128(self.prize_pool())
    }

    pub fn is_entered(&self, account_id: AccountId) -> bool {
        self.entrant_index.contains_key(&account_id)
    }

    pub fn get_entrants(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        (from..self.entrants.len().min(from.saturating_add(limit)))
            .map(|i| self.entrants[i].clone())
            .collect()
    }

    /// Most recent rounds first.
    pub fn get_rounds(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Round> {
        let total = self.rounds.len();
        let skip = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(10).min(50);
        (0..total)
            .rev()
            .skip(skip as usize)
            .take(limit as usize)
            .map(|i| self.rounds[i].clone())
            .collect()
    }

    pub fn get_pending_draw(&self) -> Option<PendingDraw> {
        self.pending.clone()
    }
}

// ----------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------

impl EarnGacha {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can do this");
    }

    /// Everything on the account except storage, entry deposits, the safety
    /// reserve, and any prize already promised to a running draw.
    fn prize_pool(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let pending = self.pending.as_ref().map(|p| p.prize.0).unwrap_or(0);
        balance.saturating_sub(storage + self.held_deposits + RESERVE.as_yoctonear() + pending)
    }

    fn add_entrant(&mut self, account_id: AccountId) {
        let idx = self.entrants.len();
        self.entrants.push(account_id.clone());
        self.entrant_index.insert(account_id, idx);
    }

    /// O(1) swap-remove. Returns false if the account was not entered.
    fn remove_entrant(&mut self, account_id: &AccountId) -> bool {
        let Some(idx) = self.entrant_index.remove(account_id) else {
            return false;
        };
        let last = self.entrants.len() - 1;
        if idx != last {
            let moved = self.entrants[last].clone();
            self.entrants[idx] = moved.clone();
            self.entrant_index.insert(moved, idx);
        }
        self.entrants.pop();
        true
    }
}

/// Picks `k` distinct indices from `0..n` with a partial Fisher–Yates shuffle,
/// using sha256(seed || round || step) as the random source.
pub fn pick_unique(n: u32, k: u32, seed: &[u8; 32], round: u32) -> Vec<u32> {
    let mut swaps: HashMap<u32, u32> = HashMap::new();
    let mut out = Vec::with_capacity(k as usize);
    for i in 0..k {
        let mut data = seed.to_vec();
        data.extend_from_slice(&round.to_le_bytes());
        data.extend_from_slice(&i.to_le_bytes());
        let hash = env::sha256_array(&data);
        let r = u64::from_le_bytes(hash[..8].try_into().unwrap());
        let j = i + (r % (n - i) as u64) as u32;
        let vj = *swaps.get(&j).unwrap_or(&j);
        let vi = *swaps.get(&i).unwrap_or(&i);
        swaps.insert(j, vi);
        out.push(vj);
    }
    out
}

/// Reads a `U128` returned by a cross-contract call. `None` if it failed.
#[allow(deprecated)]
fn read_u128_result(index: u64) -> Option<u128> {
    match env::promise_result(index) {
        PromiseResult::Successful(bytes) => {
            near_sdk::serde_json::from_slice::<U128>(&bytes).ok().map(|v| v.0)
        }
        _ => None,
    }
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    );
}

#[cfg(test)]
mod tests;
