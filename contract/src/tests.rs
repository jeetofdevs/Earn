use super::*;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, RuntimeFeesConfig};
use std::collections::HashSet;

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MIN_HOLD: u128 = 1_000;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &AccountId, balance: u128, deposit: u128, ts_sec: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("gacha.near"))
        .predecessor_account_id(predecessor.clone())
        .account_balance(NearToken::from_yoctonear(balance))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_sec * 1_000_000_000)
        .random_seed([7u8; 32]);
    b
}

fn with_results(b: VMContextBuilder, results: Vec<PromiseResult>) {
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn balance_ok(v: u128) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(v)).unwrap())
}

fn setup() -> EarnGacha {
    testing_env!(ctx(&accounts(0), 10 * ONE_NEAR, 0, 0).build());
    EarnGacha::new(accounts(0), acc("token.near"), U128(MIN_HOLD), U64(3600), None)
}

/// Runs enter + its callback for `who`, with the given token balance.
fn enter_with_balance(c: &mut EarnGacha, who: &AccountId, token_balance: u128) -> bool {
    testing_env!(ctx(who, 10 * ONE_NEAR, ENTRY_DEPOSIT.as_yoctonear(), 0).build());
    let _ = c.enter();
    let gacha = acc("gacha.near");
    with_results(ctx(&gacha, 10 * ONE_NEAR, 0, 0), vec![balance_ok(token_balance)]);
    c.on_enter_checked(who.clone(), U128(ENTRY_DEPOSIT.as_yoctonear()))
}

fn holder(i: usize) -> AccountId {
    acc(&format!("holder{i}.near"))
}

#[test]
fn pick_unique_returns_distinct_indices_in_range() {
    testing_env!(VMContextBuilder::new().build());
    for n in 1..40u32 {
        let k = n.min(10);
        let picks = pick_unique(n, k, &[3u8; 32], n);
        assert_eq!(picks.len(), k as usize);
        let set: HashSet<_> = picks.iter().collect();
        assert_eq!(set.len(), k as usize, "duplicates for n={n}");
        assert!(picks.iter().all(|&p| p < n));
    }
}

#[test]
fn pick_unique_is_roughly_uniform() {
    testing_env!(VMContextBuilder::new().build());
    let n = 20u32;
    let mut counts = vec![0u32; n as usize];
    for round in 0..2000u32 {
        for p in pick_unique(n, 10, &[9u8; 32], round) {
            counts[p as usize] += 1;
        }
    }
    // Expected 1000 picks each (2000 rounds * 10 / 20).
    assert!(counts.iter().all(|&c| (850..1150).contains(&c)), "{counts:?}");
}

#[test]
fn holder_can_enter_and_leave() {
    let mut c = setup();
    assert!(enter_with_balance(&mut c, &holder(1), MIN_HOLD));
    assert!(c.is_entered(holder(1)));
    assert_eq!(c.get_stats().entrants, 1);
    assert_eq!(c.held_deposits, ENTRY_DEPOSIT.as_yoctonear());

    testing_env!(ctx(&holder(1), 10 * ONE_NEAR, 0, 0).build());
    let _ = c.leave();
    assert!(!c.is_entered(holder(1)));
    assert_eq!(c.held_deposits, 0);
}

#[test]
fn non_holder_is_refused() {
    let mut c = setup();
    assert!(!enter_with_balance(&mut c, &holder(1), MIN_HOLD - 1));
    assert!(!c.is_entered(holder(1)));
    assert_eq!(c.held_deposits, 0);
}

#[test]
fn failed_balance_check_refuses_entry() {
    let mut c = setup();
    testing_env!(ctx(&holder(1), 10 * ONE_NEAR, ENTRY_DEPOSIT.as_yoctonear(), 0).build());
    let _ = c.enter();
    with_results(ctx(&acc("gacha.near"), 10 * ONE_NEAR, 0, 0), vec![PromiseResult::Failed]);
    assert!(!c.on_enter_checked(holder(1), U128(ENTRY_DEPOSIT.as_yoctonear())));
    assert_eq!(c.held_deposits, 0);
}

#[test]
#[should_panic(expected = "Attach 0.01 NEAR to enter")]
fn enter_requires_deposit() {
    let mut c = setup();
    testing_env!(ctx(&holder(1), 10 * ONE_NEAR, 0, 0).build());
    let _ = c.enter();
}

#[test]
fn prize_pool_excludes_reserve_and_deposits() {
    let mut c = setup();
    enter_with_balance(&mut c, &holder(1), MIN_HOLD);
    testing_env!(ctx(&accounts(0), 10 * ONE_NEAR, 0, 0).build());
    let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
    let expected = 10 * ONE_NEAR - storage - RESERVE.as_yoctonear() - ENTRY_DEPOSIT.as_yoctonear();
    assert_eq!(c.get_prize_pool().0, expected);
}

#[test]
#[should_panic(expected = "Too early")]
fn non_owner_cannot_draw_early() {
    let mut c = setup();
    enter_with_balance(&mut c, &holder(1), MIN_HOLD);
    testing_env!(ctx(&holder(1), 10 * ONE_NEAR, 0, 10).build());
    let _ = c.draw();
}

#[test]
fn draw_pays_ten_holders_equally_and_drops_sellers() {
    let mut c = setup();
    for i in 0..25 {
        enter_with_balance(&mut c, &holder(i), MIN_HOLD * 2);
    }

    // Anyone can draw after the interval.
    testing_env!(ctx(&holder(3), 10 * ONE_NEAR, 0, 3600).build());
    let pool = c.get_prize_pool().0;
    let _ = c.draw();
    let pending = c.get_pending_draw().expect("pending");
    assert_eq!(pending.candidates.len(), 10);
    assert_eq!(pending.prize.0, pool);
    assert!(c.get_stats().draw_in_progress);
    // While the draw runs, its prize is not counted in the pool.
    assert_eq!(c.get_prize_pool().0, 0);

    // 8 still hold, 1 sold, 1 balance check failed.
    let mut results: Vec<PromiseResult> = (0..8).map(|_| balance_ok(MIN_HOLD)).collect();
    results.push(balance_ok(0));
    results.push(PromiseResult::Failed);
    with_results(ctx(&acc("gacha.near"), 10 * ONE_NEAR, 0, 3600), results);
    let round = c.on_draw_checked();

    assert_eq!(round.winners.len(), 8);
    let share = pool / 8;
    assert!(round.winners.iter().all(|w| w.amount.0 == share));
    assert_eq!(round.rolled_over.0, pool - share * 8);
    assert_eq!(round.disqualified.len(), 2);
    // The seller is removed, the failed check is kept.
    assert!(!c.is_entered(pending.candidates[8].clone()));
    assert!(c.is_entered(pending.candidates[9].clone()));
    assert_eq!(c.get_stats().entrants, 24);
    assert_eq!(c.total_paid, share * 8);
    assert!(c.get_pending_draw().is_none());
    assert_eq!(c.get_rounds(None, None).len(), 1);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"draw\"")));
}

#[test]
fn draw_with_fewer_entrants_than_winners_pays_all() {
    let mut c = setup();
    for i in 0..3 {
        enter_with_balance(&mut c, &holder(i), MIN_HOLD);
    }
    testing_env!(ctx(&accounts(0), 10 * ONE_NEAR, 0, 5).build());
    let pool = c.get_prize_pool().0;
    let _ = c.draw(); // owner may draw early
    assert_eq!(c.get_pending_draw().unwrap().candidates.len(), 3);

    with_results(
        ctx(&acc("gacha.near"), 10 * ONE_NEAR, 0, 5),
        (0..3).map(|_| balance_ok(MIN_HOLD)).collect(),
    );
    let round = c.on_draw_checked();
    assert_eq!(round.winners.len(), 3);
    assert_eq!(round.winners[0].amount.0, pool / 3);
}

#[test]
fn owner_can_cancel_stuck_draw() {
    let mut c = setup();
    enter_with_balance(&mut c, &holder(1), MIN_HOLD);
    testing_env!(ctx(&accounts(0), 10 * ONE_NEAR, 0, 5).build());
    let pool = c.get_prize_pool().0;
    let _ = c.draw();
    assert_eq!(c.get_prize_pool().0, 0);
    c.cancel_pending_draw();
    assert_eq!(c.get_prize_pool().0, pool);
}

#[test]
#[should_panic(expected = "Prize pool is empty")]
fn cannot_draw_empty_pool() {
    let mut c = setup();
    enter_with_balance(&mut c, &holder(1), MIN_HOLD);
    testing_env!(ctx(&accounts(0), RESERVE.as_yoctonear(), 0, 5).build());
    let _ = c.draw();
}

#[test]
fn remove_entrant_keeps_index_consistent() {
    let mut c = setup();
    for i in 0..5 {
        enter_with_balance(&mut c, &holder(i), MIN_HOLD);
    }
    assert!(c.remove_entrant(&holder(1)));
    assert!(!c.remove_entrant(&holder(1)));
    let list = c.get_entrants(None, None);
    assert_eq!(list.len(), 4);
    for (i, a) in list.iter().enumerate() {
        assert_eq!(c.entrant_index.get(a), Some(&(i as u32)));
    }
}
