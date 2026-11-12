use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const OP: &str = "operator.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx_ms(caller: &str, deposit: u128, ns: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("valley.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ns)
        .account_balance(NearToken::from_near(1_000));
    testing_env!(b.build());
}

fn ctx(caller: &str, deposit: u128, day: u64) {
    ctx_ms(caller, deposit, day * DAY_NS + 1);
}

fn setup() -> Valley {
    ctx("deployer.testnet", 0, 1);
    Valley::new(U128(5 * NEAR), acc(OP))
}

fn charter(founder_bps: u16, sale_bps: u16, price: u128) -> Charter {
    Charter { founder_bps, sale_bps, share_price: U128(price), supply: None }
}

fn card(ref_id: Option<u32>) -> Card {
    Card { model: "z-ai/glm-5.3-flash".into(), uri: "https://agent-valley.example/card.json".into(), ref_id }
}

fn found_with(v: &mut Valley, owner: &str, agent: &str, sector: &str, seed: u128, ch: Charter) -> u32 {
    ctx(owner, seed, 1);
    v.found(format!("{owner}-co"), sector.into(), acc(agent), card(None), ch, None)
}

fn found(v: &mut Valley, owner: &str, agent: &str, sector: &str, seed: u128) -> u32 {
    found_with(v, owner, agent, sector, seed, charter(6_000, 3_000, NEAR / 1_000_000))
}

fn assert_invariants(v: &Valley) {
    let s = v.stats();
    assert!(s.ner_ok, "sum(ner) {} != external_in {}", s.ner_sum.0, s.external_in.0);
    assert!(s.balance_ok, "balance {} != capital {} + in {} - out {}", s.balance_sum.0, s.capital_in.0, s.external_in.0, s.external_out.0);
}

fn shares_of(v: &Valley, id: u32, holder: u32) -> u64 {
    v.get_company(id).unwrap().holders.iter().find(|h| h.company == Some(holder)).map(|h| h.shares).unwrap_or(0)
}

/* ---------- ledger ---------- */

#[test]
fn mul_div_handles_yocto_sized_products() {
    assert_eq!(mul_div(3 * NEAR, 2 * NEAR, NEAR), 6 * NEAR);
    assert_eq!(mul_div(u128::MAX, 7, 7), u128::MAX);
    assert_eq!(mul_div(10, 3, 4), 7);
}

#[test]
fn found_keeps_storage_cost_out_of_seed() {
    let mut v = setup();
    let id = found(&mut v, "ayse.testnet", "agent.ayse.testnet", "visual", NEAR);
    let co = v.get_company(id).unwrap();
    assert_eq!(co.stage, Stage::Idea);
    assert!(co.seed.0 < NEAR && co.seed.0 >= MIN_SEED);
    assert_eq!(co.capital.0, co.seed.0);
    assert_eq!(co.ner.0, 0);
    assert!(get_logs()[0].starts_with("EVENT_JSON:"));
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Deposit must cover storage plus 0.01 NEAR seed")]
fn found_rejects_tiny_seed() {
    let mut v = setup();
    found(&mut v, "ayse.testnet", "agent.ayse.testnet", "web", MIN_SEED / 2);
}

#[test]
fn customer_payment_is_the_only_source_of_ner() {
    let mut v = setup();
    let id = found(&mut v, "ayse.testnet", "agent.ayse.testnet", "social", NEAR);
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
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "security", NEAR);
    let c = found(&mut v, "c.testnet", "agent.c.testnet", "research", NEAR);
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
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "visual", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "software", NEAR);
    ctx("agent.a.testnet", 0, 2);
    v.trade(a, b, U128(NEAR / 2));
    assert_eq!(v.get_company(b).unwrap().ner.0, 0);
    assert_eq!(v.stats().ner_sum.0, 0);
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Only the company agent can trade")]
fn only_the_agent_can_trade() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "web", NEAR);
    ctx("stranger.testnet", 0, 2);
    v.trade(a, b, U128(1));
}

#[test]
#[should_panic(expected = "Agent is paused")]
fn kill_switch_stops_the_agent() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "web", NEAR);
    ctx("a.testnet", 0, 2);
    v.set_paused(a, true);
    ctx("agent.a.testnet", 0, 2);
    v.trade(a, b, U128(1));
}

#[test]
fn daily_limit_resets_next_day() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "web", NEAR);
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
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "web", NEAR);
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
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "software", NEAR);
    ctx("agent.a.testnet", 0, 2);
    let _ = v.spend(a, U128(1), acc("scammer.testnet"));
}

#[test]
fn spend_to_allowed_receiver_leaves_the_system() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "software", NEAR);
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
#[should_panic(expected = "Company is closed")]
fn closed_company_takes_no_payments() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "visual", NEAR);
    ctx("a.testnet", 0, 2);
    let _ = v.close(a);
    ctx("customer.testnet", NEAR, 2);
    v.pay(a);
}

/* ---------- Agent ID ---------- */

#[test]
fn every_agent_gets_one_id_and_a_card() {
    let mut v = setup();
    let a = found(&mut v, "ayse.testnet", "agent.ayse.testnet", "design", NEAR);
    assert_eq!(v.agent_id(acc("agent.ayse.testnet")), Some(a));
    assert_eq!(v.agent_id(acc("nobody.testnet")), None);
    let co = v.get_company(a).unwrap();
    assert_eq!(co.sector, "design");
    assert_eq!(co.model, "z-ai/glm-5.3-flash");
    ctx("ayse.testnet", 0, 2);
    v.set_card(a, "openai/gpt-oss-120b".into(), "https://x.example/kadraj.json".into());
    assert_eq!(v.get_company(a).unwrap().model, "openai/gpt-oss-120b");
}

#[test]
#[should_panic(expected = "This agent already has an Agent ID")]
fn one_agent_cannot_register_twice() {
    let mut v = setup();
    found(&mut v, "a.testnet", "agent.shared.testnet", "web", NEAR);
    found(&mut v, "b.testnet", "agent.shared.testnet", "web", NEAR);
}

#[test]
fn the_operator_founds_for_an_owner_and_can_manage() {
    let mut v = setup();
    ctx(OP, NEAR, 1);
    let id = v.found("Kadraj".into(), "visual".into(), acc("kadraj.valley.testnet"), card(Some(12)), charter(7_000, 2_000, 1), Some(acc("kadraj.near")));
    let co = v.get_company(id).unwrap();
    assert_eq!(co.owner, acc("kadraj.near"));
    assert_eq!(co.ref_id, Some(12));
    ctx(OP, 0, 2);
    v.set_paused(id, true);
    assert!(v.get_company(id).unwrap().paused);
}

#[test]
#[should_panic(expected = "Only the operator founds for someone else")]
fn strangers_cannot_found_in_someone_elses_name() {
    let mut v = setup();
    ctx("mallory.testnet", NEAR, 1);
    v.found("Fake".into(), "web".into(), acc("agent.fake.testnet"), card(None), charter(5_000, 0, 0), Some(acc("victim.testnet")));
}

/* ---------- shares ---------- */

#[test]
fn founding_splits_a_million_shares_three_ways() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(6_000, 2_500, 1));
    let co = v.get_company(a).unwrap();
    assert_eq!(co.holders[0].shares, 600_000);
    assert_eq!(co.holders[0].account, Some(acc("a.testnet")));
    assert_eq!(co.for_sale, 250_000);
    assert_eq!(co.pool, 150_000);
    assert_eq!(co.held() + co.for_sale + co.pool, DEFAULT_SUPPLY);
}

#[test]
fn an_agent_buys_shares_from_capital_and_becomes_a_partner() {
    let mut v = setup();
    let price = NEAR / 1_000_000; // a whole company costs 1 NEAR at this price
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(6_000, 3_000, price));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    let b_cap = v.get_company(b).unwrap().capital.0;
    ctx("agent.b.testnet", 0, 2);
    v.buy_shares(a, b, 100_000);
    let (ca, cb) = (v.get_company(a).unwrap(), v.get_company(b).unwrap());
    assert_eq!(shares_of(&v, a, b), 100_000);
    assert_eq!(ca.for_sale, 200_000);
    assert_eq!(ca.raised.0, 100_000 * price);
    assert_eq!(cb.capital.0, b_cap - 100_000 * price);
    assert_eq!(ca.stage, Stage::Funded);
    assert_eq!(v.stats().ner_sum.0, 0, "investing creates no NER");
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Only the buying company's agent or owner can buy")]
fn only_agents_can_buy_shares() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("outsider.testnet", 0, 2);
    v.buy_shares(a, b, 10);
}

#[test]
#[should_panic(expected = "Not that many shares for sale")]
fn nobody_buys_more_than_is_for_sale() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(9_000, 1_000, 1));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("agent.b.testnet", 0, 2);
    v.buy_shares(a, b, 100_001);
}

#[test]
#[should_panic(expected = "Shares are paid from capital, and there is not enough")]
fn earned_money_cannot_buy_shares() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(6_000, 3_000, NEAR));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("customer.testnet", 50 * NEAR, 2);
    v.pay(b);
    ctx("agent.b.testnet", 0, 2);
    v.buy_shares(a, b, 2);
}

#[test]
fn an_investment_ring_does_not_raise_ner() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("customer.testnet", NEAR, 2);
    v.pay(a);
    for _ in 0..20 {
        ctx("agent.a.testnet", 0, 2);
        v.buy_shares(b, a, 1_000);
        ctx("agent.b.testnet", 0, 2);
        v.buy_shares(a, b, 1_000);
    }
    assert_eq!(v.stats().ner_sum.0, NEAR);
    assert_invariants(&v);
}

#[test]
fn the_pool_grants_shares_to_partner_agents() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(6_000, 2_000, 1));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("a.testnet", 0, 2);
    v.grant_shares(a, b, 50_000);
    assert_eq!(shares_of(&v, a, b), 50_000);
    assert_eq!(v.get_company(a).unwrap().pool, 150_000);
}

#[test]
fn dividends_follow_shares_and_carry_ner_to_partners() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(7_500, 2_500, 1));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("agent.b.testnet", 0, 2);
    v.buy_shares(a, b, 250_000); // b now holds a quarter of what is held
    ctx("customer.testnet", 4 * NEAR, 2);
    v.pay(a);
    ctx("a.testnet", 0, 3);
    let _ = v.distribute(a, U128(2 * NEAR));
    let (ca, cb) = (v.get_company(a).unwrap(), v.get_company(b).unwrap());
    assert_eq!(cb.earned.0, NEAR / 2, "a quarter of the dividend");
    assert_eq!(cb.ner.0, NEAR / 2, "revenue a partner receives keeps its origin");
    assert_eq!(ca.earned.0, 2 * NEAR);
    assert_eq!(v.stats().external_out.0, 3 * NEAR / 2, "the founder's three quarters left as NEAR");
    assert_invariants(&v);
}

#[test]
fn close_pays_founders_out_and_partners_in() {
    let mut v = setup();
    let price = NEAR / 1_000_000;
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "visual", NEAR, charter(5_000, 5_000, price));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", 2 * NEAR);
    ctx("agent.b.testnet", 0, 2);
    v.buy_shares(a, b, 500_000);
    let b_before = v.get_company(b).unwrap().balance();
    let left = v.get_company(a).unwrap().balance();
    ctx("a.testnet", 0, 3);
    let _ = v.close(a);
    let co = v.get_company(a).unwrap();
    assert!(!co.active);
    assert_eq!(co.balance(), 0);
    assert_eq!(v.get_company(b).unwrap().balance() - b_before, left - left / 2, "the partner's half stays in the valley");
    assert_invariants(&v);
}

/* ---------- sealed auctions ---------- */

fn three_suppliers(v: &mut Valley) -> (u32, u32, u32, u32) {
    let buyer = found(v, "web.testnet", "agent.web.testnet", "web", NEAR);
    let s1 = found(v, "s1.testnet", "agent.s1.testnet", "design", NEAR);
    let s2 = found(v, "s2.testnet", "agent.s2.testnet", "design", NEAR);
    let s3 = found(v, "s3.testnet", "agent.s3.testnet", "design", NEAR);
    (buyer, s1, s2, s3)
}

fn seal_bid(v: &mut Valley, round: u64, co: u32, bid: u128, list: u128, salt: &str, at_ns: u64) {
    ctx_ms(OP, 0, at_ns);
    let commit = commit_of(round, co, bid, list, salt);
    v.seal(round, co, commit);
}

fn rv(company: u32, bid: u128, list: u128, salt: &str) -> Reveal {
    Reveal { company, bid: U128(bid), list: U128(list), salt: salt.into() }
}

#[test]
fn the_contract_picks_the_lowest_bid_and_the_second_price() {
    let mut v = setup();
    let (buyer, s1, s2, s3) = three_suppliers(&mut v);
    ctx_ms(OP, 0, 1_000_000_000);
    v.open_round(7, buyer, "design".into(), 5_000);
    seal_bid(&mut v, 7, s1, 300_000, 500_000, "a1", 2_000_000_000);
    seal_bid(&mut v, 7, s2, 200_000, 600_000, "b2", 2_100_000_000);
    seal_bid(&mut v, 7, s3, 250_000, 500_000, "c3", 2_200_000_000);
    ctx_ms(OP, 0, 6_000_000_000);
    let w = v.reveal(7, vec![rv(s1, 300_000, 500_000, "a1"), rv(s2, 200_000, 600_000, "b2"), rv(s3, 250_000, 500_000, "c3")]);
    assert_eq!(w, Some(s2));
    let r = v.get_round(7).unwrap();
    assert_eq!(r.price, Some(U128(250_000)));
    assert!(r.closed);
    let rep = v.get_company(s2).unwrap().rep;
    assert_eq!((rep.auctions_bid, rep.auctions_won), (1, 1));
    assert_eq!(v.get_company(s1).unwrap().rep.auctions_won, 0);
    ctx_ms(OP, 0, 7_000_000_000);
    v.record_delivery(s2, buyer, U128(250_000), Some(7));
    assert_eq!(v.get_company(s2).unwrap().rep.parts_delivered, 1);
    assert_eq!(v.get_company(buyer).unwrap().rep.volume_bought.0, 250_000);
}

#[test]
fn a_tie_goes_to_the_earlier_seal_and_a_lone_bid_pays_list() {
    let mut v = setup();
    let (buyer, s1, s2, _) = three_suppliers(&mut v);
    ctx_ms(OP, 0, 1_000_000_000);
    v.open_round(1, buyer, "design".into(), 5_000);
    seal_bid(&mut v, 1, s2, 200_000, 400_000, "x", 2_000_000_000);
    seal_bid(&mut v, 1, s1, 200_000, 400_000, "y", 3_000_000_000);
    ctx_ms(OP, 0, 6_000_000_000);
    assert_eq!(v.reveal(1, vec![rv(s1, 200_000, 400_000, "y"), rv(s2, 200_000, 400_000, "x")]), Some(s2));
    ctx_ms(OP, 0, 6_000_000_000);
    v.open_round(2, buyer, "design".into(), 7_000);
    seal_bid(&mut v, 2, s1, 150_000, 400_000, "z", 6_500_000_000);
    ctx_ms(OP, 0, 8_000_000_000);
    v.reveal(2, vec![rv(s1, 150_000, 400_000, "z")]);
    assert_eq!(v.get_round(2).unwrap().price, Some(U128(400_000)));
}

#[test]
#[should_panic(expected = "Reveal does not match the sealed bid")]
fn a_changed_bid_is_rejected_at_reveal() {
    let mut v = setup();
    let (buyer, s1, _, _) = three_suppliers(&mut v);
    ctx_ms(OP, 0, 1_000_000_000);
    v.open_round(3, buyer, "design".into(), 5_000);
    seal_bid(&mut v, 3, s1, 300_000, 500_000, "salt", 2_000_000_000);
    ctx_ms(OP, 0, 6_000_000_000);
    v.reveal(3, vec![rv(s1, 100_000, 500_000, "salt")]);
}

#[test]
#[should_panic(expected = "Round is still open")]
fn no_reveal_before_the_round_closes() {
    let mut v = setup();
    let (buyer, s1, _, _) = three_suppliers(&mut v);
    ctx_ms(OP, 0, 1_000_000_000);
    v.open_round(4, buyer, "design".into(), 50_000);
    seal_bid(&mut v, 4, s1, 300_000, 500_000, "s", 2_000_000_000);
    ctx_ms(OP, 0, 6_000_000_000);
    v.reveal(4, vec![rv(s1, 300_000, 500_000, "s")]);
}

#[test]
#[should_panic(expected = "Only an active supplier in the round's sector can bid")]
fn only_suppliers_of_the_sector_bid() {
    let mut v = setup();
    let (buyer, _, _, _) = three_suppliers(&mut v);
    let other = found(&mut v, "law.testnet", "agent.law.testnet", "legal", NEAR);
    ctx_ms(OP, 0, 1_000_000_000);
    v.open_round(5, buyer, "design".into(), 5_000);
    seal_bid(&mut v, 5, other, 1, 1, "s", 2_000_000_000);
}

#[test]
#[should_panic(expected = "Only the operator can do this")]
fn only_the_operator_reveals() {
    let mut v = setup();
    let (buyer, _, _, _) = three_suppliers(&mut v);
    ctx_ms(OP, 0, 1_000_000_000);
    v.open_round(6, buyer, "design".into(), 5_000);
    ctx_ms("mallory.testnet", 0, 6_000_000_000);
    v.reveal(6, vec![]);
}

#[test]
fn the_commitment_matches_the_app() {
    // sha256("7|12|200000|600000|b2") computed by node: the app and the contract seal the same way.
    ctx("deployer.testnet", 0, 1);
    assert_eq!(commit_of(7, 12, 200_000, 600_000, "b2"), "8ed5c0d8a06dcbaadb5c94be9c5f57d5c7716618b7031d681aa9c9d316470abe");
}

/* ---------- customer orders: escrow and automatic split ---------- */

fn pay_order(v: &mut Valley, customer: &str, company: u32, r: &str, amount: u128, ms: u64) {
    ctx_ms(customer, amount, ms * 1_000_000);
    v.place_order(company, r.into());
}

#[test]
fn a_paid_order_waits_in_escrow_outside_the_books() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "design", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    let o = v.get_order("o1".into()).unwrap();
    assert_eq!(o.status, OrderStatus::Paid);
    assert_eq!(o.customer, acc("cust.testnet"));
    assert_eq!(v.get_company(a).unwrap().earned.0, 0, "not revenue until delivered");
    assert_invariants(&v);
}

#[test]
fn settling_splits_fuel_parts_tax_and_profit_and_keeps_the_books() {
    let mut v = setup();
    let web = found(&mut v, "w.testnet", "agent.w.testnet", "web", NEAR);
    let ui = found(&mut v, "u.testnet", "agent.u.testnet", "design", NEAR);
    pay_order(&mut v, "cust.testnet", web, "o1", 10 * NEAR, 1_000);
    ctx_ms(OP, 0, 2_000_000_000);
    v.settle_order("o1".into(), U128(NEAR), vec![PartPay { company: ui, amount: U128(4 * NEAR) }]);
    let o = v.get_order("o1".into()).unwrap();
    assert_eq!(o.status, OrderStatus::Settled);
    // profit 10 - 1 - 4 = 5; tax 2% of 5 = 0.1; company keeps 4.9
    assert_eq!(o.tax.0, NEAR / 10);
    assert_eq!(o.profit.0, 49 * NEAR / 10);
    assert_eq!(v.get_company(web).unwrap().earned.0, 49 * NEAR / 10);
    assert_eq!(v.get_company(ui).unwrap().earned.0, 4 * NEAR);
    assert_eq!(v.get_company(ui).unwrap().ner.0, 4 * NEAR, "the supplier's part keeps its origin");
    let t = v.treasury();
    assert_eq!((t.fuel.0, t.tax.0), (NEAR, NEAR / 10));
    assert_eq!(v.stats().ner_sum.0, 10 * NEAR);
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Fuel and parts exceed the payment")]
fn a_settlement_cannot_take_more_than_was_paid() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    ctx_ms(OP, 0, 2_000_000_000);
    v.settle_order("o1".into(), U128(2 * NEAR), vec![]);
}

#[test]
#[should_panic(expected = "Only the operator can do this")]
fn only_the_operator_settles() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    ctx_ms("a.testnet", 0, 2_000_000_000);
    v.settle_order("o1".into(), U128(0), vec![]);
}

#[test]
fn a_failed_job_is_refunded_and_cannot_be_settled_after() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    ctx_ms(OP, 0, 2_000_000_000);
    let _ = v.refund_order("o1".into());
    assert_eq!(v.get_order("o1".into()).unwrap().status, OrderStatus::Refunded);
    assert_invariants(&v);
}

#[test]
fn the_customer_takes_the_money_back_when_the_agent_runs_out_of_time() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    ctx_ms("cust.testnet", 0, (1_000 + 2 * 3_600_000) * 1_000_000);
    let _ = v.claim_refund("o1".into());
    assert_eq!(v.get_order("o1".into()).unwrap().status, OrderStatus::Refunded);
}

#[test]
#[should_panic(expected = "The agent still has time to deliver")]
fn no_early_self_refund() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    ctx_ms("cust.testnet", 0, 60_000 * 1_000_000);
    let _ = v.claim_refund("o1".into());
}

#[test]
#[should_panic(expected = "This order is already paid")]
fn an_order_is_paid_once() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_000);
    pay_order(&mut v, "cust.testnet", a, "o1", NEAR, 1_001);
}

#[test]
fn the_fuel_treasury_pays_out_for_model_credit() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    pay_order(&mut v, "cust.testnet", a, "o1", 2 * NEAR, 1_000);
    ctx_ms(OP, 0, 2_000_000_000);
    v.settle_order("o1".into(), U128(NEAR), vec![]);
    let _ = v.withdraw_treasury("fuel".into(), U128(NEAR), acc("credits.testnet"));
    assert_eq!(v.treasury().fuel.0, 0);
    assert_invariants(&v);
}

/* ---------- companies change hands ---------- */

#[test]
fn the_owner_hands_the_company_over_with_the_founder_shares() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx("a.testnet", 0, 2);
    v.transfer_company(a, acc("b.testnet"));
    let co = v.get_company(a).unwrap();
    assert_eq!(co.owner, acc("b.testnet"));
    assert_eq!(co.holders[0].account, Some(acc("b.testnet")), "the founder's stake moves with the company");
    ctx("b.testnet", 0, 2);
    v.set_paused(a, true);
    assert!(v.get_company(a).unwrap().paused, "the new owner manages it");
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn a_stranger_cannot_take_a_company() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx("mallory.testnet", 0, 2);
    v.transfer_company(a, acc("mallory.testnet"));
}

#[test]
fn a_sale_moves_the_company_and_leaves_the_price_for_the_seller() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    let before = v.get_company(a).unwrap().balance();
    ctx_ms("buyer.testnet", 5 * NEAR, 1_000_000_000);
    v.buy_company(a, "s1".into(), acc("newboss.testnet"));
    assert_eq!(v.get_company(a).unwrap().owner, acc("a.testnet"), "nothing moves before the sale completes");
    ctx_ms(OP, 0, 2_000_000_000);
    v.complete_sale("s1".into());
    assert_eq!(v.get_company(a).unwrap().owner, acc("newboss.testnet"));
    assert_eq!(v.get_sale("s1".into()).unwrap().status, SaleStatus::Completed);
    assert_eq!(v.proceeds_of(acc("a.testnet")).0, 5 * NEAR);
    assert_eq!(v.get_company(a).unwrap().balance(), before, "the price is the seller's money, not the company's");
    assert_invariants(&v);
    ctx("a.testnet", 0, 3);
    let _ = v.claim_proceeds();
    assert_eq!(v.proceeds_of(acc("a.testnet")).0, 0);
}

#[test]
#[should_panic(expected = "The company changed hands since this payment; refund it")]
fn a_sale_cannot_complete_after_the_company_changed_hands() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx_ms("buyer.testnet", NEAR, 1_000_000_000);
    v.buy_company(a, "s1".into(), acc("buyer.testnet"));
    ctx("a.testnet", 0, 2);
    v.transfer_company(a, acc("friend.testnet"));
    ctx_ms(OP, 0, 3_000_000_000);
    v.complete_sale("s1".into());
}

#[test]
fn a_failed_sale_is_refunded_and_a_late_one_can_be_taken_back() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx_ms("buyer.testnet", NEAR, 1_000_000_000);
    v.buy_company(a, "s1".into(), acc("buyer.testnet"));
    ctx_ms(OP, 0, 2_000_000_000);
    let _ = v.refund_sale("s1".into());
    assert_eq!(v.get_sale("s1".into()).unwrap().status, SaleStatus::Refunded);
    ctx_ms("buyer.testnet", NEAR, 3_000_000_000);
    v.buy_company(a, "s2".into(), acc("buyer.testnet"));
    ctx_ms("buyer.testnet", 0, (3_000 + 2 * 3_600_000) * 1_000_000);
    let _ = v.claim_sale_refund("s2".into());
    assert_eq!(v.get_sale("s2".into()).unwrap().status, SaleStatus::Refunded);
    assert_eq!(v.get_company(a).unwrap().owner, acc("a.testnet"));
}

/* ---------- shares as tokens (NEP-245) ---------- */

fn bal(v: &Valley, who: &str, id: u32) -> u128 {
    v.mt_balance_of(acc(who), id.to_string()).0
}

#[test]
fn shares_are_tokens_with_a_fixed_supply_and_a_mint_event() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"nep245\"") && l.contains("\"event\":\"mt_mint\"") && l.contains("\"owner_id\":\"a.testnet\"")));
    assert_eq!(v.mt_supply(a.to_string()), Some(U128(1_000_000)));
    assert_eq!(bal(&v, "a.testnet", a), 600_000, "the founder's stake");
    assert_eq!(v.mt_metadata_contract().spec, "mt-1.0.0");
    let m = v.mt_metadata_base_by_token_id(vec![a.to_string(), "99".into()]);
    assert_eq!(m[0].as_ref().unwrap().decimals.as_deref(), Some("0"));
    assert!(m[1].is_none());
}

#[test]
fn anyone_buys_shares_with_near_and_it_counts_as_capital() {
    let mut v = setup();
    let price = NEAR / 1_000; // 0.001 NEAR a share
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(6_000, 3_000, price));
    ctx("fan.testnet", 100 * price + 7, 2);
    let _ = v.buy_shares_near(a, 100);
    let co = v.get_company(a).unwrap();
    assert_eq!(bal(&v, "fan.testnet", a), 100);
    assert_eq!(co.for_sale, 300_000 - 100);
    assert_eq!(co.ner.0, 0, "buying shares never creates NER");
    assert_eq!(v.mt_tokens_for_owner(acc("fan.testnet")), vec![(a.to_string(), U128(100))]);
    assert_invariants(&v);
}

#[test]
fn tokens_move_between_accounts_and_the_dividend_follows_them() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(10_000, 0, 0));
    ctx("a.testnet", 1, 2);
    v.mt_transfer(acc("friend.testnet"), a.to_string(), U128(250_000), None, Some("gift".into()));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"mt_transfer\"") && l.contains("\"new_owner_id\":\"friend.testnet\"")));
    assert_eq!(bal(&v, "a.testnet", a), 750_000);
    assert_eq!(bal(&v, "friend.testnet", a), 250_000);
    ctx("customer.testnet", 4 * NEAR, 2);
    v.pay(a);
    ctx("a.testnet", 0, 3);
    let _ = v.distribute(a, U128(4 * NEAR));
    assert_eq!(v.stats().external_out.0, 4 * NEAR, "both holders were paid in NEAR");
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_transfer_needs_one_yocto() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx("a.testnet", 0, 2);
    v.mt_transfer(acc("friend.testnet"), a.to_string(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "No shares of this company in this account")]
fn nobody_sends_shares_they_do_not_hold() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx("thief.testnet", 1, 2);
    v.mt_transfer(acc("thief2.testnet"), a.to_string(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "Attach the price of the shares")]
fn shares_cost_their_price() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(6_000, 3_000, NEAR / 1_000));
    ctx("fan.testnet", NEAR / 1_000 - 1, 2);
    let _ = v.buy_shares_near(a, 1);
}

#[test]
fn a_partner_company_shows_its_shares_under_its_agent_account() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(7_500, 2_500, 1));
    let b = found(&mut v, "b.testnet", "agent.b.testnet", "design", NEAR);
    ctx("agent.b.testnet", 0, 2);
    v.buy_shares(a, b, 1_000);
    assert_eq!(bal(&v, "agent.b.testnet", a), 1_000);
    assert_eq!(bal(&v, "b.testnet", a), 0, "the company's shares stay with the company, not its owner");
}

#[test]
fn handing_over_merges_with_shares_the_new_owner_already_had() {
    let mut v = setup();
    let a = found_with(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR, charter(10_000, 0, 0));
    ctx("a.testnet", 1, 2);
    v.mt_transfer(acc("new.testnet"), a.to_string(), U128(1_000), None, None);
    ctx("a.testnet", 0, 2);
    v.transfer_company(a, acc("new.testnet"));
    let co = v.get_company(a).unwrap();
    assert_eq!(co.holders.len(), 1);
    assert_eq!(bal(&v, "new.testnet", a), 1_000_000);
}

#[test]
fn the_founder_picks_the_supply_with_no_upper_limit() {
    let mut v = setup();
    let big = 21_000_000_000_000_000u64; // far past a million, still a whole number of shares
    ctx("a.testnet", NEAR, 1);
    let a = v.found("big-co".into(), "web".into(), acc("agent.a.testnet"), card(None), Charter { founder_bps: 6_000, sale_bps: 3_000, share_price: U128(1), supply: Some(U64(big)) }, None);
    assert!(get_logs().iter().any(|l| l.contains(&format!("\"supply\":{big}"))));
    assert_eq!(v.mt_supply(a.to_string()), Some(U128(big as u128)));
    assert_eq!(bal(&v, "a.testnet", a), (big / 10 * 6) as u128);
    let co = v.get_company(a).unwrap();
    assert_eq!(co.supply(), big, "founder + for sale + pool add up to the supply");
    ctx("fan.testnet", 1_000, 2);
    let _ = v.buy_shares_near(a, 1_000);
    assert_eq!(v.mt_supply(a.to_string()), Some(U128(big as u128)), "buying moves shares, it never mints");
}

#[test]
#[should_panic(expected = "A company needs at least 100 shares")]
fn a_supply_has_a_floor() {
    let mut v = setup();
    ctx("a.testnet", NEAR, 1);
    v.found("tiny".into(), "web".into(), acc("agent.a.testnet"), card(None), Charter { founder_bps: 10_000, sale_bps: 0, share_price: U128(0), supply: Some(U64(10)) }, None);
}

#[test]
fn the_owner_or_operator_sets_the_share_price() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx(OP, 0, 2);
    v.set_share_price(a, U128(NEAR / 100));
    assert_eq!(v.get_company(a).unwrap().share_price.0, NEAR / 100);
    ctx("fan.testnet", NEAR / 10, 2);
    let _ = v.buy_shares_near(a, 10);
    assert_eq!(bal(&v, "fan.testnet", a), 10);
    assert_invariants(&v);
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn a_stranger_cannot_set_the_share_price() {
    let mut v = setup();
    let a = found(&mut v, "a.testnet", "agent.a.testnet", "web", NEAR);
    ctx("fan.testnet", 0, 2);
    v.set_share_price(a, U128(1));
}
