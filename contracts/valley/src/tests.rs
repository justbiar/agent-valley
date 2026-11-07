use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(caller: &str, deposit: u128, day: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("valley.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(day * DAY_NS + 1)
        .account_balance(NearToken::from_near(1_000));
    testing_env!(b.build());
}

fn setup() -> Valley {
    ctx("deployer.testnet", 0, 1);
    Valley::new(U128(5 * NEAR))
}

fn found(v: &mut Valley, owner: &str, agent: &str, sector: Sector, seed: u128) -> u32 {
    ctx(owner, seed, 1);
    v.found(format!("{owner}-co"), sector, acc(agent))
}

fn assert_invariants(v: &Valley) {
    let s = v.stats();
    assert!(s.ner_ok, "sum(ner) {} != external_in {}", s.ner_sum.0, s.external_in.0);
    assert!(s.balance_ok, "balance {} != capital {} + in {} - out {}", s.balance_sum.0, s.capital_in.0, s.external_in.0, s.external_out.0);
}

#[test]
fn mul_div_handles_yocto_sized_products() {
    assert_eq!(mul_div(3 * NEAR, 2 * NEAR, NEAR), 6 * NEAR);
    assert_eq!(mul_div(u128::MAX, 7, 7), u128::MAX);
    assert_eq!(mul_div(10, 3, 4), 7);
}

#[test]
fn found_keeps_storage_cost_out_of_seed() {
    let mut v = setup();
    let id = found(&mut v, "ayse.testnet", "agent.ayse.testnet", Sector::Visual, NEAR);
    let co = v.get_company(id).unwrap();
    assert_eq!(co.stage, Stage::Idea);
    assert!(co.seed.0 < NEAR && co.seed.0 >= MIN_SEED);
    assert_eq!(co.capital.0, co.seed.0);
    assert_eq!(co.ner.0, 0);
    assert!(get_logs()[0].starts_with("EVENT_JSON:"));
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Deposit must cover storage plus 0.1 NEAR seed")]
fn found_rejects_tiny_seed() {
    let mut v = setup();
    found(&mut v, "ayse.testnet", "agent.ayse.testnet", Sector::Web, MIN_SEED / 2);
}

#[test]
fn customer_payment_is_the_only_source_of_ner() {
    let mut v = setup();
    let id = found(&mut v, "ayse.testnet", "agent.ayse.testnet", Sector::Social, NEAR);
    ctx("customer.testnet", 2 * NEAR, 2);
    v.pay(id);
    let co = v.get_company(id).unwrap();
    assert_eq!(co.ner.0, 2 * NEAR);
    assert_eq!(co.earned.0, 2 * NEAR);
    assert_invariants(&v);
}

#[test]
fn wash_ring_does_not_raise_total_ner() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Web, NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", Sector::Security, NEAR);
    let c = found(&mut v, "c.testnet", "agent.c.testnet", Sector::Research, NEAR);
    ctx("customer.testnet", 3 * NEAR, 2);
    v.pay(a);
    let total = v.stats().ner_sum.0;
    for _ in 0..100 {
        for (from, to, agent) in [(a, b, "agent.a.testnet"), (b, c, "agent.b.testnet"), (c, a, "agent.c.testnet")] {
            ctx(agent, 0, 2);
            v.trade(from, to, U128(NEAR / 100));
        }
    }
    assert_eq!(v.stats().ner_sum.0, total);
    assert_invariants(&v);
}

#[test]
fn spending_capital_on_another_company_creates_no_ner() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Visual, NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", Sector::Software, NEAR);
    ctx("agent.a.testnet", 0, 2);
    v.trade(a, b, U128(NEAR / 2));
    assert_eq!(v.get_company(b).unwrap().ner.0, 0);
    assert_eq!(v.stats().ner_sum.0, 0);
    assert_invariants(&v);
}

#[test]
fn stages_move_from_workshop_to_company_to_headquarters() {
    let mut v = setup();
    let id = found(&mut v, "ayse.testnet", "agent.ayse.testnet", Sector::Research, NEAR);
    ctx("customer.testnet", 6 * NEAR, 2);
    v.pay(id);
    assert_eq!(v.get_company(id).unwrap().stage, Stage::Idea, "sales alone do not skip funding");
    ctx("fund.testnet", 2 * NEAR, 3);
    let bps = v.invest(id, U128(18 * NEAR));
    assert_eq!(bps, 1_000);
    let co = v.get_company(id).unwrap();
    assert_eq!(co.stage, Stage::Market, "funded and already above the sales bar");
    assert_eq!(co.holders.iter().map(|h| h.bps).sum::<u32>(), 10_000);
    assert_invariants(&v);
}

#[test]
fn investment_is_capital_not_revenue() {
    let mut v = setup();
    let id = found(&mut v, "ayse.testnet", "agent.ayse.testnet", Sector::Web, NEAR);
    ctx("fund.testnet", 3 * NEAR, 2);
    v.invest(id, U128(9 * NEAR));
    let co = v.get_company(id).unwrap();
    assert_eq!(co.stage, Stage::Funded);
    assert_eq!(co.ner.0, 0);
    assert_eq!(co.raised.0, 3 * NEAR);
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Only the company agent can trade")]
fn only_the_agent_can_trade() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Web, NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", Sector::Web, NEAR);
    ctx("stranger.testnet", 0, 2);
    v.trade(a, b, U128(1));
}

#[test]
#[should_panic(expected = "Agent is paused")]
fn kill_switch_stops_the_agent() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Web, NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", Sector::Web, NEAR);
    ctx("a.testnet", 0, 2);
    v.set_paused(a, true);
    ctx("agent.a.testnet", 0, 2);
    v.trade(a, b, U128(1));
}

#[test]
fn daily_limit_resets_next_day() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Web, NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", Sector::Web, NEAR);
    ctx("a.testnet", 0, 2);
    v.set_limits(a, U128(NEAR / 10), vec![]);
    ctx("agent.a.testnet", 0, 2);
    v.trade(a, b, U128(NEAR / 10));
    ctx("agent.a.testnet", 0, 3);
    v.trade(a, b, U128(NEAR / 10));
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Daily spend limit reached")]
fn daily_limit_blocks_overspend() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Web, NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", Sector::Web, NEAR);
    ctx("a.testnet", 0, 2);
    v.set_limits(a, U128(NEAR / 10), vec![]);
    ctx("agent.a.testnet", 0, 2);
    v.trade(a, b, U128(NEAR / 10));
    v.trade(a, b, U128(1));
}

#[test]
#[should_panic(expected = "Receiver is not on the allow list")]
fn spend_needs_an_allowed_receiver() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Software, NEAR);
    ctx("agent.a.testnet", 0, 2);
    let _ = v.spend(a, U128(1), acc("scammer.testnet"));
}

#[test]
fn spend_to_allowed_receiver_leaves_the_system() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Software, NEAR);
    ctx("customer.testnet", NEAR, 2);
    v.pay(a);
    ctx("a.testnet", 0, 2);
    v.set_limits(a, U128(0), vec![acc("inference.testnet")]);
    ctx("agent.a.testnet", 0, 2);
    let _ = v.spend(a, U128(NEAR / 4), acc("inference.testnet"));
    let s = v.stats();
    assert_eq!(s.external_out.0, NEAR / 4);
    assert_eq!(s.ner_sum.0, NEAR, "outside costs do not erase earned history");
    assert_invariants(&v);
}

#[test]
fn close_pays_out_and_keeps_books_balanced() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Visual, NEAR);
    ctx("fund.testnet", NEAR, 2);
    v.invest(a, U128(3 * NEAR));
    ctx("a.testnet", 0, 3);
    let _ = v.close(a);
    let co = v.get_company(a).unwrap();
    assert!(!co.active);
    assert_eq!(co.earned.0 + co.capital.0, 0);
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Company is closed")]
fn closed_company_takes_no_payments() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", Sector::Visual, NEAR);
    ctx("a.testnet", 0, 2);
    let _ = v.close(a);
    ctx("customer.testnet", NEAR, 2);
    v.pay(a);
}
