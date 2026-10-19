//! Earn Gacha — a NEAR contract that sends 100% of the creator fees, in
//! $EARN, to 10 random $EARN holders. Holders don't need to do anything:
//! holding at least `min_hold` $EARN is enough.
//!
//! How it works:
//! 1. Creator fees are held as $EARN on this contract. Any $EARN sent here
//!    counts (plain `ft_transfer` or `ft_transfer_call`).
//! 2. The owner pulls the gacha with `draw(holders)`, passing the current
//!    holder list from an indexer. The contract stores a hash of that list,
//!    picks 10 random accounts from it with NEAR's on-chain randomness,
//!    re-checks each one's real $EARN balance on the token contract, and
//!    sends the whole pool, split equally, to those holding `min_hold`.
//! 3. Picks below `min_hold` (sold, or never held) get nothing and their share
//!    goes to the others. Failed transfers stay in the pool for next time.

use std::collections::{HashMap, HashSet};

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue, PromiseResult,
};

/// NEAR always kept on the contract for storage and gas.
pub const RESERVE: NearToken = NearToken::from_millinear(500); // 0.5 NEAR
pub const DEFAULT_WINNERS: u32 = 10;
pub const MAX_WINNERS: u32 = 10;
/// Upper bound on one holder snapshot, to keep `draw` within gas.
pub const MAX_SNAPSHOT: usize = 5_000;

const GAS_FOR_BALANCE_CHECK: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(8);
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(25);
const GAS_FOR_DRAW_CALLBACK: Gas = Gas::from_tgas(150);

const EVENT_STANDARD: &str = "earn-gacha";
const EVENT_VERSION: &str = "2.0.0";

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Rounds,
    Excluded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Winner {
    pub account_id: AccountId,
    /// $EARN, in the token's smallest unit.
    pub amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u32,
    pub timestamp: U64,
    /// $EARN on the contract when the draw ran.
    pub prize_pool: U128,
    /// Website batch this draw was for (30-minute windows), if any.
    pub batch: Option<U64>,
    /// Number of accounts in the holder snapshot used for this draw.
    pub snapshot_size: u32,
    /// sha256 (hex) of the snapshot account ids joined with "\n".
    pub snapshot_hash: String,
    pub winners: Vec<Winner>,
    /// Picked accounts holding less than `min_hold` (or whose check failed).
    pub disqualified: Vec<AccountId>,
    /// Winners whose transfer failed; their share stays in the pool.
    pub failed_payouts: Vec<AccountId>,
    /// $EARN left in the pool after this draw.
    pub rolled_over: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingDraw {
    pub round_id: u32,
    pub candidates: Vec<AccountId>,
    pub batch: Option<U64>,
    pub snapshot_size: u32,
    pub snapshot_hash: String,
    pub started_at: U64,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub token_id: AccountId,
    pub min_hold: U128,
    pub winners_per_draw: u32,
    pub max_snapshot: u32,
}

#[near(serializers = [json])]
pub struct Stats {
    pub rounds: u32,
    /// Total $EARN paid to holders.
    pub total_paid: U128,
    pub last_draw_at: U64,
    /// Highest batch drawn so far.
    pub last_batch: Option<U64>,
    pub draw_in_progress: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EarnGacha {
    owner_id: AccountId,
    token_id: AccountId,
    min_hold: u128,
    winners_per_draw: u32,
    last_draw_ns: u64,
    /// Accounts that can never win: pools, exchanges, team wallets, etc.
    excluded: IterableSet<AccountId>,
    rounds: Vector<Round>,
    pending: Option<PendingDraw>,
    total_paid: u128,
    /// Highest batch number drawn so far; each batch can be drawn only once.
    last_batch: Option<u64>,
}

#[near]
impl EarnGacha {
    #[init]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        min_hold: U128,
        winners_per_draw: Option<u32>,
    ) -> Self {
        let winners = winners_per_draw.unwrap_or(DEFAULT_WINNERS);
        require!(winners > 0 && winners <= MAX_WINNERS, "winners_per_draw must be 1..=10");
        Self {
            owner_id,
            token_id,
            min_hold: min_hold.0,
            winners_per_draw: winners,
            last_draw_ns: 0,
            excluded: IterableSet::new(StorageKey::Excluded),
            rounds: Vector::new(StorageKey::Rounds),
            pending: None,
            total_paid: 0,
            last_batch: None,
        }
    }

    // ------------------------------------------------------------------
    // Fees in ($EARN)
    // ------------------------------------------------------------------

    /// NEP-141 receiver: accepts $EARN sent with `ft_transfer_call` into the
    /// prize pool. Other tokens are returned.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        #[allow(unused_variables)] msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_id {
            return PromiseOrValue::Value(amount);
        }
        emit("deposit", json!({ "account_id": sender_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    // ------------------------------------------------------------------
    // Drawing (owner only)
    // ------------------------------------------------------------------

    /// Pull the gacha and pay the winners in $EARN. Owner only. Attach 300 Tgas.
    ///
    /// `holders` is the list to draw from (e.g. everyone who joined a website
    /// batch). Order does not matter; duplicates, excluded accounts and this
    /// contract are skipped. Every pick's balance is re-checked on the token
    /// contract. `batch` is just recorded with the round.
    pub fn draw(&mut self, holders: Vec<AccountId>, batch: Option<U64>) -> Promise {
        self.assert_owner();
        require!(self.pending.is_none(), "A draw is already in progress");
        require!(!holders.is_empty(), "Holder list is empty");
        require!(holders.len() <= MAX_SNAPSHOT, "Holder list too long (max 5000)");
        if let Some(b) = batch {
            require!(self.last_batch.map_or(true, |last| b.0 > last), "This batch was already drawn");
        }

        let now = env::block_timestamp();
        let round_id = self.rounds.len();
        let snapshot_hash = hex(&env::sha256_array(
            holders.iter().map(|a| a.as_str()).collect::<Vec<_>>().join("\n").as_bytes(),
        ));
        let me = env::current_account_id();
        let candidates = pick_accounts(
            &holders,
            self.winners_per_draw as usize,
            &env::random_seed_array(),
            round_id,
            |a| a == &me || a == &self.token_id || self.excluded.contains(a),
        );
        require!(!candidates.is_empty(), "No eligible holders in the list");

        if let Some(b) = batch {
            self.last_batch = Some(b.0);
        }
        self.pending = Some(PendingDraw {
            round_id,
            candidates: candidates.clone(),
            batch,
            snapshot_size: holders.len() as u32,
            snapshot_hash,
            started_at: U64(now),
        });
        self.last_draw_ns = now;

        // Result 0: our own $EARN balance (the prize pool). Results 1..: candidates.
        let token = self.token_id.clone();
        let balance_of = |a: AccountId| {
            ext_ft::ext(token.clone()).with_static_gas(GAS_FOR_BALANCE_CHECK).ft_balance_of(a)
        };
        let checks = candidates
            .into_iter()
            .fold(balance_of(me.clone()), |acc, a| acc.and(balance_of(a)));

        checks.then(Self::ext(me).with_static_gas(GAS_FOR_DRAW_CALLBACK).on_draw_checked())
    }

    /// Decides the winners and sends their $EARN. Must not panic, so a draw
    /// can never get stuck halfway.
    #[private]
    pub fn on_draw_checked(&mut self) -> PromiseOrValue<Round> {
        let Some(pending) = self.pending.clone() else {
            return PromiseOrValue::Value(self.empty_round(0));
        };

        let Some(pool) = read_u128_result(0) else {
            log!("Could not read the prize pool; draw cancelled");
            self.pending = None;
            return PromiseOrValue::Value(self.empty_round(pending.round_id));
        };

        let mut qualified = Vec::new();
        let mut disqualified = Vec::new();
        for (i, account_id) in pending.candidates.iter().enumerate() {
            match read_u128_result(i as u64 + 1) {
                Some(b) if b >= self.min_hold => qualified.push(account_id.clone()),
                _ => disqualified.push(account_id.clone()),
            }
        }

        let share = if qualified.is_empty() { 0 } else { pool / qualified.len() as u128 };
        if share == 0 {
            self.pending = None;
            let round = self.record_round(&pending, pool, vec![], disqualified, vec![], pool);
            return PromiseOrValue::Value(round);
        }

        let memo = format!("EARN gacha draw #{}", pending.round_id + 1);
        let token = self.token_id.clone();
        let transfer = |a: &AccountId| {
            ext_ft::ext(token.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FOR_FT_TRANSFER)
                .ft_transfer(a.clone(), U128(share), Some(memo.clone()))
        };
        let payouts = qualified[1..]
            .iter()
            .fold(transfer(&qualified[0]), |acc, a| acc.and(transfer(a)));

        PromiseOrValue::Promise(payouts.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                .on_payouts_done(U128(pool), U128(share), qualified, disqualified),
        ))
    }

    /// Records which transfers went through and closes the draw.
    #[private]
    pub fn on_payouts_done(
        &mut self,
        pool: U128,
        share: U128,
        qualified: Vec<AccountId>,
        disqualified: Vec<AccountId>,
    ) -> Round {
        let pending = self.pending.take().unwrap_or(PendingDraw {
            round_id: self.rounds.len(),
            candidates: vec![],
            batch: None,
            snapshot_size: 0,
            snapshot_hash: String::new(),
            started_at: U64(self.last_draw_ns),
        });

        let mut winners = Vec::new();
        let mut failed = Vec::new();
        for (i, account_id) in qualified.into_iter().enumerate() {
            if promise_ok(i as u64) {
                winners.push(Winner { account_id, amount: share });
            } else {
                failed.push(account_id);
            }
        }
        let paid = share.0 * winners.len() as u128;
        self.total_paid += paid;
        self.record_round(&pending, pool.0, winners, disqualified, failed, pool.0 - paid)
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// Clears a draw whose callbacks never ran. No $EARN was sent, so the
    /// pool is untouched.
    pub fn cancel_pending_draw(&mut self) {
        self.assert_owner();
        require!(self.pending.take().is_some(), "No pending draw");
    }

    /// Sends spare NEAR (e.g. fees the launchpad paid in NEAR) to the owner,
    /// so it can be swapped to $EARN and sent back to the pool.
    pub fn withdraw_near(&mut self, amount: Option<U128>) -> Promise {
        self.assert_owner();
        let spare = self.spare_near();
        let amount = amount.map(|a| a.0).unwrap_or(spare);
        require!(amount > 0 && amount <= spare, "Not enough spare NEAR");
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    /// Accounts that can never win (liquidity pools, exchanges, team wallets).
    pub fn add_excluded(&mut self, account_ids: Vec<AccountId>) {
        self.assert_owner();
        for a in account_ids {
            self.excluded.insert(a);
        }
    }

    pub fn remove_excluded(&mut self, account_ids: Vec<AccountId>) {
        self.assert_owner();
        for a in account_ids {
            self.excluded.remove(&a);
        }
    }

    pub fn set_min_hold(&mut self, min_hold: U128) {
        self.assert_owner();
        self.min_hold = min_hold.0;
    }

    pub fn set_winners_per_draw(&mut self, winners_per_draw: u32) {
        self.assert_owner();
        require!(
            winners_per_draw > 0 && winners_per_draw <= MAX_WINNERS,
            "winners_per_draw must be 1..=10"
        );
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
            max_snapshot: MAX_SNAPSHOT as u32,
        }
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            rounds: self.rounds.len(),
            total_paid: U128(self.total_paid),
            last_draw_at: U64(self.last_draw_ns),
            last_batch: self.last_batch.map(U64),
            draw_in_progress: self.pending.is_some(),
        }
    }

    /// NEAR the owner can withdraw.
    pub fn get_spare_near(&self) -> U128 {
        U128(self.spare_near())
    }

    pub fn get_excluded(&self) -> Vec<AccountId> {
        self.excluded.iter().cloned().collect()
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

    fn spare_near(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        balance.saturating_sub(storage + RESERVE.as_yoctonear())
    }

    fn empty_round(&self, id: u32) -> Round {
        Round {
            id,
            timestamp: U64(env::block_timestamp()),
            prize_pool: U128(0),
            batch: None,
            snapshot_size: 0,
            snapshot_hash: String::new(),
            winners: vec![],
            disqualified: vec![],
            failed_payouts: vec![],
            rolled_over: U128(0),
        }
    }

    fn record_round(
        &mut self,
        pending: &PendingDraw,
        pool: u128,
        winners: Vec<Winner>,
        disqualified: Vec<AccountId>,
        failed_payouts: Vec<AccountId>,
        rolled_over: u128,
    ) -> Round {
        let round = Round {
            id: pending.round_id,
            timestamp: pending.started_at,
            prize_pool: U128(pool),
            batch: pending.batch,
            snapshot_size: pending.snapshot_size,
            snapshot_hash: pending.snapshot_hash.clone(),
            winners,
            disqualified,
            failed_payouts,
            rolled_over: U128(rolled_over),
        };
        self.rounds.push(round.clone());
        emit("draw", json!(round));
        round
    }
}

/// Picks up to `k` distinct accounts from `list` in random order (lazy
/// Fisher–Yates), skipping duplicates and accounts where `skip` is true.
pub fn pick_accounts(
    list: &[AccountId],
    k: usize,
    seed: &[u8; 32],
    round: u32,
    skip: impl Fn(&AccountId) -> bool,
) -> Vec<AccountId> {
    let n = list.len() as u32;
    let mut swaps: HashMap<u32, u32> = HashMap::new();
    let mut seen: HashSet<&AccountId> = HashSet::new();
    let mut out = Vec::with_capacity(k);
    for i in 0..n {
        if out.len() == k {
            break;
        }
        let j = i + (rand_u64(seed, round, i) % (n - i) as u64) as u32;
        let vj = *swaps.get(&j).unwrap_or(&j);
        let vi = *swaps.get(&i).unwrap_or(&i);
        swaps.insert(j, vi);
        let a = &list[vj as usize];
        if !skip(a) && seen.insert(a) {
            out.push(a.clone());
        }
    }
    out
}

fn rand_u64(seed: &[u8; 32], round: u32, step: u32) -> u64 {
    let mut data = seed.to_vec();
    data.extend_from_slice(&round.to_le_bytes());
    data.extend_from_slice(&step.to_le_bytes());
    let hash = env::sha256_array(&data);
    u64::from_le_bytes(hash[..8].try_into().unwrap())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

/// True if the cross-contract call at `index` succeeded.
#[allow(deprecated)]
fn promise_ok(index: u64) -> bool {
    matches!(env::promise_result(index), PromiseResult::Successful(_))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    );
}

#[cfg(test)]
mod tests;
