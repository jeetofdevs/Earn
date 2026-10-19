use super::*;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, RuntimeFeesConfig};
use std::collections::{HashMap, HashSet};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const ONE_EARN: u128 = 1_000_000_000_000_000_000; // 18 decimals
const MIN_HOLD: u128 = 1_000 * ONE_EARN;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}
fn owner() -> AccountId {
    accounts(0)
}
fn gacha() -> AccountId {
    acc("gacha.near")
}
fn token() -> AccountId {
    acc("earn.token.near")
}
fn holder(i: usize) -> AccountId {
    acc(&format!("holder{i}.near"))
}
fn holders(n: usize) -> Vec<AccountId> {
    (0..n).map(holder).collect()
}

fn ctx(predecessor: &AccountId) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(gacha())
        .predecessor_account_id(predecessor.clone())
        .account_balance(NearToken::from_yoctonear(10 * ONE_NEAR))
        .block_timestamp(1_000_000_000)
        .random_seed([7u8; 32]);
    b
}

fn with_results(results: Vec<PromiseResult>) {
    testing_env!(
        ctx(&gacha()).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn bal(v: u128) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(v)).unwrap())
}
fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

fn setup() -> EarnGacha {
    testing_env!(ctx(&owner()).build());
    EarnGacha::new(owner(), token(), U128(MIN_HOLD), None)
}

/// Owner starts a draw with `list`; returns the picked candidates.
fn start_draw(c: &mut EarnGacha, list: Vec<AccountId>) -> Vec<AccountId> {
    testing_env!(ctx(&owner()).build());
    let _ = c.draw(list, Some(U64(42)));
    c.get_pending_draw().expect("pending").candidates
}

#[test]
fn pick_accounts_returns_distinct_accounts() {
    testing_env!(VMContextBuilder::new().build());
    for n in 1..40usize {
        let list = holders(n);
        let picks = pick_accounts(&list, 10, &[3u8; 32], n as u32, |_| false);
        assert_eq!(picks.len(), n.min(10));
        assert_eq!(picks.iter().collect::<HashSet<_>>().len(), picks.len(), "duplicates for n={n}");
    }
}

#[test]
fn pick_accounts_skips_duplicates_and_excluded() {
    testing_env!(VMContextBuilder::new().build());
    let mut list = holders(5);
    list.extend(holders(5)); // every holder listed twice
    list.push(acc("pool.near"));
    let picks = pick_accounts(&list, 10, &[1u8; 32], 0, |a| a.as_str() == "pool.near");
    assert_eq!(picks.len(), 5);
    assert!(!picks.contains(&acc("pool.near")));
}

#[test]
fn pick_accounts_is_roughly_uniform() {
    testing_env!(VMContextBuilder::new().build());
    let list = holders(20);
    let mut counts: HashMap<AccountId, u32> = HashMap::new();
    for round in 0..2000u32 {
        for p in pick_accounts(&list, 10, &[9u8; 32], round, |_| false) {
            *counts.entry(p).or_default() += 1;
        }
    }
    // Expected 1000 picks each (2000 rounds * 10 / 20).
    assert!(counts.values().all(|&c| (850..1150).contains(&c)), "{counts:?}");
}

#[test]
fn accepts_earn_and_returns_other_tokens() {
    let mut c = setup();
    testing_env!(ctx(&token()).build());
    match c.ft_on_transfer(holder(1), U128(5 * ONE_EARN), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!("expected value"),
    }
    testing_env!(ctx(&acc("other.token.near")).build());
    match c.ft_on_transfer(holder(1), U128(5), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 5),
        _ => panic!("expected value"),
    }
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn only_owner_can_draw() {
    let mut c = setup();
    testing_env!(ctx(&holder(1)).build());
    let _ = c.draw(holders(3), None);
}

/// Owner draws from 25 holders. Of the 10 picks: 8 hold enough, 1 is below
/// the minimum, 1 balance check failed. Then 1 of the 8 transfers fails.
#[test]
fn owner_draw_pays_earn_and_handles_failures() {
    let mut c = setup();
    let candidates = start_draw(&mut c, holders(25));
    assert_eq!(candidates.len(), 10);
    assert!(c.get_stats().draw_in_progress);

    let pool = 8_000 * ONE_EARN + 7; // odd amount to check rounding
    let mut results = vec![bal(pool)];
    results.extend((0..8).map(|_| bal(MIN_HOLD)));
    results.push(bal(MIN_HOLD - 1));
    results.push(PromiseResult::Failed);
    with_results(results);
    assert!(matches!(c.on_draw_checked(), PromiseOrValue::Promise(_)));
    assert!(c.get_stats().draw_in_progress, "still waiting on transfers");

    let share = pool / 8;
    let qualified = candidates[..8].to_vec();
    let disqualified = candidates[8..].to_vec();
    let mut transfers: Vec<PromiseResult> = (0..7).map(|_| ok()).collect();
    transfers.push(PromiseResult::Failed);
    with_results(transfers);
    let round = c.on_payouts_done(U128(pool), U128(share), qualified.clone(), disqualified);

    assert_eq!(round.winners.len(), 7);
    assert!(round.winners.iter().all(|w| w.amount.0 == share));
    assert_eq!(round.failed_payouts, vec![qualified[7].clone()]);
    assert_eq!(round.disqualified.len(), 2);
    assert_eq!(round.rolled_over.0, pool - share * 7);
    assert_eq!(round.snapshot_size, 25);
    assert_eq!(round.batch, Some(U64(42)));
    assert_eq!(round.snapshot_hash.len(), 64);
    assert_eq!(c.total_paid, share * 7);
    assert!(!c.get_stats().draw_in_progress);
    assert_eq!(c.get_rounds(None, None).len(), 1);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"draw\"")));
}

#[test]
fn draw_with_empty_pool_rolls_over_without_transfers() {
    let mut c = setup();
    assert_eq!(start_draw(&mut c, holders(3)).len(), 3);
    let mut results = vec![bal(0)];
    results.extend((0..3).map(|_| bal(MIN_HOLD)));
    with_results(results);
    match c.on_draw_checked() {
        PromiseOrValue::Value(r) => assert!(r.winners.is_empty()),
        _ => panic!("no transfers expected"),
    }
    assert!(!c.get_stats().draw_in_progress);
}

#[test]
fn failed_pool_read_cancels_draw() {
    let mut c = setup();
    start_draw(&mut c, holders(1));
    with_results(vec![PromiseResult::Failed, bal(MIN_HOLD)]);
    assert!(matches!(c.on_draw_checked(), PromiseOrValue::Value(_)));
    assert!(c.get_pending_draw().is_none());
    assert_eq!(c.get_rounds(None, None).len(), 0);
}

#[test]
fn owner_can_cancel_stuck_draw() {
    let mut c = setup();
    start_draw(&mut c, holders(1));
    c.cancel_pending_draw();
    assert!(c.get_pending_draw().is_none());
}

#[test]
fn excluded_accounts_never_picked() {
    let mut c = setup();
    testing_env!(ctx(&owner()).build());
    c.add_excluded(vec![holder(0), holder(1)]);
    assert_eq!(c.get_excluded().len(), 2);
    let mut list = holders(4);
    list.push(gacha());
    list.push(token());
    let picks = start_draw(&mut c, list);
    assert_eq!(picks.len(), 2);
    assert!(picks.iter().all(|a| a == &holder(2) || a == &holder(3)));
}

#[test]
#[should_panic(expected = "No eligible holders")]
fn draw_needs_an_eligible_holder() {
    let mut c = setup();
    testing_env!(ctx(&owner()).build());
    let _ = c.draw(vec![gacha(), token()], None);
}

#[test]
#[should_panic(expected = "Holder list too long")]
fn draw_rejects_oversized_snapshot() {
    let mut c = setup();
    testing_env!(ctx(&owner()).build());
    let _ = c.draw(holders(MAX_SNAPSHOT + 1), None);
}

#[test]
fn spare_near_excludes_reserve() {
    let mut c = setup();
    testing_env!(ctx(&owner()).build());
    let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
    assert_eq!(c.get_spare_near().0, 10 * ONE_NEAR - storage - RESERVE.as_yoctonear());
    let _ = c.withdraw_near(None);
}

#[test]
#[should_panic(expected = "Not enough spare NEAR")]
fn cannot_withdraw_reserve() {
    let mut c = setup();
    testing_env!(ctx(&owner()).build());
    let _ = c.withdraw_near(Some(U128(10 * ONE_NEAR)));
}

#[test]
#[should_panic(expected = "This batch was already drawn")]
fn batch_cannot_be_drawn_twice() {
    let mut c = setup();
    start_draw(&mut c, holders(3)); // batch 42
    c.cancel_pending_draw();
    testing_env!(ctx(&owner()).build());
    let _ = c.draw(holders(3), Some(U64(42)));
}

#[test]
fn later_batch_can_be_drawn() {
    let mut c = setup();
    start_draw(&mut c, holders(3)); // batch 42
    c.cancel_pending_draw();
    testing_env!(ctx(&owner()).build());
    let _ = c.draw(holders(3), Some(U64(43)));
    assert_eq!(c.get_stats().last_batch, Some(U64(43)));
}
