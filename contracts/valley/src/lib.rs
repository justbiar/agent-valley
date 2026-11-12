//! Agent Valley: agent identity, company shares, sealed part auctions and the net external revenue (NER) ledger.
//!
//! Agent ID. Every company is an agent with an on-chain card, in the spirit of ERC-8004: identity (owner, agent
//! account, sector, model, card URI), reputation built only from facts this contract recorded (auctions bid and won,
//! parts delivered and bought), and validation (sealed auction rounds anyone can re-check). `agent_id(account)`
//! resolves an agent account to its company.
//!
//! Shares. A company is founded with the supply its founder picks (1,000,000 by default, no upper limit, fixed for
//! ever), split three ways: the founder's stake, shares for sale at a
//! fixed price, and an ecosystem pool the company can grant to partner agents. Only registered agent companies can
//! buy, and they pay from their capital, so investing between agents never creates NER.
//!
//! Money. Every company holds NEAR in two buckets:
//! - `earned`: money that traces back to an outside customer
//! - `capital`: seed money and investment
//! Customer payments add NER. Trades and dividends between companies move the earned part and the NER with it.
//! Capital never creates NER, so a ring of agents paying or investing in each other cannot raise the total.
//!
//! Orders. A customer pays for a job into escrow here. When the agent delivers, the operator settles the order and
//! this contract splits the money itself: model fuel to the fuel treasury, parts to the supplier agents, the tax on
//! the profit to the tax treasury, and the rest to the company. A failed job is refunded, and a customer whose order
//! is not settled in time takes the money back without anyone's help.
//!
//! Companies change hands. An owner hands a company over (transfer_company), or a buyer pays for it into escrow
//! (buy_company) and the sale completes: the company, and the founder's shares with it, pass to the new owner, and
//! the price waits here as the seller's proceeds until the seller claims it. Sale money is never company money.
//!
//! Invariants, checked by `stats()` and the tests:
//! 1. sum(ner) == external_in
//! 2. sum(earned + capital) == capital_in + external_in - external_out

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const MIN_SEED: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
const DAY_NS: u64 = 86_400_000_000_000;
const MAX_ALLOW: usize = 10;
const MAX_HOLDERS: usize = 24;
const MAX_SEALS: usize = 32;
/// The supply a company gets when its founder does not choose one. The founder can choose any supply from
/// MIN_SUPPLY up; it is fixed at founding and nothing can mint more later.
pub const DEFAULT_SUPPLY: u64 = 1_000_000;
pub const MIN_SUPPLY: u64 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Idea,
    Funded,
    Market,
}

/// A shareholder is either another agent company (a partner) or a plain account (the founder).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Holder {
    pub company: Option<u32>,
    pub account: Option<AccountId>,
    pub shares: u64,
}

/// Reputation from recorded facts only. Nobody can rate an agent; it earns these by trading here.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Reputation {
    pub auctions_bid: u32,
    pub auctions_won: u32,
    pub parts_delivered: u32,
    pub parts_bought: u32,
    /// In the app's unit (USD micros), as recorded by the operator.
    pub volume_sold: U128,
    pub volume_bought: U128,
}

/// What a founder writes on the agent's card.
#[near(serializers = [json])]
pub struct Card {
    pub model: String,
    /// Link to the agent card (JSON: services, endpoints, pricing).
    pub uri: String,
    /// The company's id in the Agent Valley app, used in sealed bids.
    pub ref_id: Option<u32>,
}

/// How many shares the company has and how the founder splits them, in basis points. The rest goes to the
/// ecosystem pool.
#[near(serializers = [json])]
pub struct Charter {
    pub founder_bps: u16,
    pub sale_bps: u16,
    /// yoctoNEAR per share.
    pub share_price: U128,
    /// Total shares, fixed for ever. DEFAULT_SUPPLY when left out; no upper limit beyond u64.
    #[serde(default)]
    pub supply: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Company {
    pub id: u32,
    pub ref_id: Option<u32>,
    pub name: String,
    pub sector: String,
    pub model: String,
    pub card_uri: String,
    pub stage: Stage,
    /// Human who founded the company and sets its limits.
    pub owner: AccountId,
    /// Agent account allowed to trade, spend and buy shares for the company. One company per agent.
    pub agent: AccountId,
    pub earned: U128,
    pub capital: U128,
    pub ner: U128,
    pub seed: U128,
    pub raised: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub spend_day: u64,
    pub allow: Vec<AccountId>,
    pub share_price: U128,
    pub for_sale: u64,
    pub pool: u64,
    pub holders: Vec<Holder>,
    pub rep: Reputation,
    pub paused: bool,
    pub active: bool,
    pub created_ms: u64,
}

impl Company {
    fn balance(&self) -> u128 {
        self.earned.0 + self.capital.0
    }

    /// Takes `amount` pro rata from both buckets.
    fn take(&mut self, amount: u128) -> (u128, u128) {
        let total = self.balance();
        require!(amount <= total, "Not enough balance");
        if total == 0 {
            return (0, 0);
        }
        let mut e = mul_div(amount, self.earned.0, total);
        e = e.min(self.earned.0);
        let mut c = amount - e;
        if c > self.capital.0 {
            c = self.capital.0;
            e = amount - c;
        }
        self.earned = U128(self.earned.0 - e);
        self.capital = U128(self.capital.0 - c);
        (e, c)
    }

    fn charge_limit(&mut self, amount: u128, now: u64) {
        let day = now / DAY_NS;
        if day != self.spend_day {
            self.spend_day = day;
            self.spent_today = U128(0);
        }
        let next = self.spent_today.0 + amount;
        require!(self.daily_limit.0 == 0 || next <= self.daily_limit.0, "Daily spend limit reached");
        self.spent_today = U128(next);
    }

    /// Every share ever issued: held, offered for sale, or still in the pool. Shares only move, so this is the
    /// supply chosen at founding.
    pub fn supply(&self) -> u64 {
        self.held() + self.for_sale + self.pool
    }

    fn held(&self) -> u64 {
        self.holders.iter().map(|h| h.shares).sum()
    }

    fn add_holder(&mut self, company: Option<u32>, account: Option<AccountId>, shares: u64) {
        match self.holders.iter_mut().find(|h| h.company == company && h.account == account) {
            Some(h) => h.shares += shares,
            None => {
                require!(self.holders.len() < MAX_HOLDERS, "Too many shareholders");
                self.holders.push(Holder { company, account, shares });
            }
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Seal {
    pub company: u32,
    pub commit: String,
    pub at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bid {
    pub company: u32,
    pub bid: U128,
    pub list: U128,
}

#[near(serializers = [json])]
pub struct Reveal {
    pub company: u32,
    pub bid: U128,
    pub list: U128,
    pub salt: String,
}

/// A part listing. Suppliers seal bids while it is open; the reveal is checked here and this contract picks the
/// winner and the price, so the platform cannot change the result.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u64,
    pub buyer: u32,
    pub sector: String,
    pub opened_ms: u64,
    pub closes_ms: u64,
    pub seals: Vec<Seal>,
    pub bids: Vec<Bid>,
    pub winner: Option<u32>,
    pub price: Option<U128>,
    pub closed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Paid,
    Settled,
    Refunded,
}

/// A customer's paid job, held in escrow until it is settled or refunded.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub order_ref: String,
    pub company: u32,
    pub customer: AccountId,
    pub amount: U128,
    pub status: OrderStatus,
    pub paid_ms: u64,
    pub closed_ms: Option<u64>,
    pub fuel: U128,
    pub parts: U128,
    pub tax: U128,
    pub profit: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SaleStatus {
    Paid,
    Completed,
    Refunded,
}

/// A buyer's payment for a whole company, in escrow until the sale completes or is refunded.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Sale {
    pub sale_ref: String,
    pub company: u32,
    pub buyer: AccountId,
    pub new_owner: AccountId,
    pub seller: AccountId,
    pub amount: U128,
    pub status: SaleStatus,
    pub paid_ms: u64,
    pub closed_ms: Option<u64>,
}

#[near(serializers = [json])]
pub struct PartPay {
    pub company: u32,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct Treasury {
    pub fuel: U128,
    pub tax: U128,
    pub tax_bps: u16,
    pub refund_after_ms: u64,
}

#[near(serializers = [json])]
pub struct Stats {
    pub companies: u32,
    pub capital_in: U128,
    pub external_in: U128,
    pub external_out: U128,
    pub ner_sum: U128,
    pub balance_sum: U128,
    pub ner_ok: bool,
    pub balance_ok: bool,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Companies,
    Agents,
    Rounds,
    Orders,
    Sales,
    Proceeds,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Valley {
    companies: IterableMap<u32, Company>,
    agents: LookupMap<AccountId, u32>,
    rounds: LookupMap<u64, Round>,
    next_id: u32,
    /// The Agent Valley server: opens rounds, seals and reveals for agents, records deliveries.
    operator: AccountId,
    /// NER a funded company needs before it moves to its headquarters.
    market_ner: u128,
    capital_in: u128,
    external_in: u128,
    external_out: u128,
    orders: LookupMap<String, Order>,
    /// Model fuel and tax collected at settlement; they have left the companies' books (external_out).
    fuel_treasury: u128,
    tax_treasury: u128,
    tax_bps: u16,
    /// After this long an unsettled order (or company sale) can be taken back by its payer.
    refund_after_ms: u64,
    sales: LookupMap<String, Sale>,
    /// What sellers can claim from completed company sales.
    proceeds: LookupMap<AccountId, u128>,
}

/// The state before company sales existed, read once by `migrate`.
#[near(serializers = [borsh])]
struct ValleyV3 {
    companies: IterableMap<u32, Company>,
    agents: LookupMap<AccountId, u32>,
    rounds: LookupMap<u64, Round>,
    next_id: u32,
    operator: AccountId,
    market_ner: u128,
    capital_in: u128,
    external_in: u128,
    external_out: u128,
    orders: LookupMap<String, Order>,
    fuel_treasury: u128,
    tax_treasury: u128,
    tax_bps: u16,
    refund_after_ms: u64,
}

/* ---------- shares as tokens (NEP-245 multi-token) ----------
   Every company's shares are one token of this contract: the token id is the company id ("3"), the supply is
   what the founder chose, fixed at founding. The balances are the same holder list the dividends and the votes read, so a token moves its dividend
   rights with it. A plain account holds its own tokens and can send them to anyone; a company's tokens are shown
   under its agent account and stay with the company. Anyone can buy the shares a company offers, paying NEAR into
   its capital, so the price never creates NER. */

pub const MT_SPEC: &str = "mt-1.0.0";

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MtBaseTokenMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub decimals: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub copies: Option<u64>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

fn mt_event(event: &str, data: String) {
    env::log_str(&format!("EVENT_JSON:{{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{data}]}}"));
}
fn mt_mint_log(owner: &AccountId, id: u32, amount: u64, memo: &str) {
    mt_event("mt_mint", format!("{{\"owner_id\":\"{owner}\",\"token_ids\":[\"{id}\"],\"amounts\":[\"{amount}\"],\"memo\":{memo:?}}}"));
}
fn token_of(token_id: &str) -> u32 {
    token_id.parse().unwrap_or_else(|_| env::panic_str("Token id is a company id"))
}
fn symbol_of(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect::<String>().to_uppercase();
    if s.is_empty() { "SHARE".into() } else { s }
}

#[near]
impl Valley {
    pub fn mt_metadata_contract(&self) -> MtContractMetadata {
        MtContractMetadata { spec: MT_SPEC.into(), name: "Agent Valley company shares".into() }
    }

    pub fn mt_metadata_base_by_token_id(&self, token_ids: Vec<String>) -> Vec<Option<MtBaseTokenMetadata>> {
        token_ids.iter().map(|t| {
            let id: u32 = t.parse().ok()?;
            let co = self.companies.get(&id)?;
            Some(MtBaseTokenMetadata {
                name: format!("{} shares", co.name), id: t.clone(), symbol: Some(symbol_of(&co.name)), icon: None,
                decimals: Some("0".into()), base_uri: None, reference: Some(co.card_uri.clone()), copies: Some(co.supply()), reference_hash: None,
            })
        }).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MtToken>> {
        token_ids.iter().map(|t| { let id: u32 = t.parse().ok()?; self.companies.get(&id).map(|_| MtToken { token_id: t.clone(), owner_id: None }) }).collect()
    }

    /// Shares held by an account: its own, plus those of the company it is the agent of.
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let Some(co) = token_id.parse::<u32>().ok().and_then(|id| self.companies.get(&id)) else { return U128(0) };
        let agent_of = self.agents.get(&account_id).copied();
        U128(co.holders.iter().filter(|h| match (h.company, &h.account) {
            (None, Some(a)) => a == &account_id,
            (Some(c), _) => Some(c) == agent_of,
            _ => false,
        }).map(|h| h.shares as u128).sum())
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        token_id.parse::<u32>().ok().and_then(|id| self.companies.get(&id)).map(|co| U128(co.supply() as u128))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    /// Every token an account holds, as (company id, shares). Not part of NEP-245; a convenience for wallets and the app.
    pub fn mt_tokens_for_owner(&self, account_id: AccountId) -> Vec<(String, U128)> {
        let agent_of = self.agents.get(&account_id).copied();
        self.companies.iter().filter_map(|(id, co)| {
            let n: u64 = co.holders.iter().filter(|h| match (h.company, &h.account) { (None, Some(a)) => a == &account_id, (Some(c), _) => Some(c) == agent_of, _ => false }).map(|h| h.shares).sum();
            (n > 0).then(|| (id.to_string(), U128(n as u128)))
        }).collect()
    }

    /// Sends shares from the caller's own account to another account. The dividend rights go with them.
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        require!(env::attached_deposit().as_yoctonear() == 1, "Requires attached deposit of exactly 1 yoctoNEAR");
        require!(approval.is_none(), "Approvals are not supported");
        self.transfer_shares(token_of(&token_id), receiver_id, amount.0, memo);
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        require!(env::attached_deposit().as_yoctonear() == 1, "Requires attached deposit of exactly 1 yoctoNEAR");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts differ in length");
        require!(approvals.map(|a| a.iter().all(|x| x.is_none())).unwrap_or(true), "Approvals are not supported");
        for (t, a) in token_ids.iter().zip(amounts) {
            self.transfer_shares(token_of(t), receiver_id.clone(), a.0, memo.clone());
        }
    }

    /// Anyone buys shares a company offers, at its fixed price in NEAR. The money goes to the company's capital
    /// (it counts as investment, never as NER) and anything paid over the price is sent back.
    #[payable]
    pub fn buy_shares_near(&mut self, id: u32, shares: u64) -> PromiseOrValue<()> {
        require!(shares > 0, "Buy at least one share");
        let buyer = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let market_ner = self.market_ner;
        let co = self.active_mut(id);
        require!(shares <= co.for_sale, "Not that many shares for sale");
        require!(co.share_price.0 > 0, "This company does not sell shares");
        let cost = co.share_price.0.checked_mul(shares as u128).unwrap_or_else(|| env::panic_str("Price overflow"));
        require!(paid >= cost, "Attach the price of the shares");
        co.capital = U128(co.capital.0 + cost);
        co.raised = U128(co.raised.0 + cost);
        co.for_sale -= shares;
        co.add_holder(None, Some(buyer.clone()), shares);
        let promoted = promote(co, market_ner);
        self.capital_in += cost;
        emit("buy_shares", format!("{{\"id\":{id},\"account\":\"{buyer}\",\"shares\":{shares},\"cost\":\"{cost}\"}}"));
        mt_mint_log(&buyer, id, shares, "bought");
        if let Some(stage) = promoted {
            emit("stage", format!("{{\"id\":{id},\"stage\":\"{stage}\"}}"));
        }
        if paid > cost { PromiseOrValue::Promise(Promise::new(buyer).transfer(NearToken::from_yoctonear(paid - cost))) } else { PromiseOrValue::Value(()) }
    }

    /// The owner, or the operator for app companies, sets the price of the shares for sale in yoctoNEAR. The app
    /// prices shares in dollars and keeps this in step with the NEAR rate.
    pub fn set_share_price(&mut self, id: u32, price: U128) {
        require!(price.0 > 0, "Price must be positive");
        let co = self.managed_mut(id);
        require!(co.active, "Company is closed");
        co.share_price = price;
        emit("share_price", format!("{{\"id\":{id},\"price\":\"{}\"}}", price.0));
    }

    /// Writes an mt_mint event for shares that existed before the token view, so indexers and wallets see them.
    /// Operator only; it changes no balance.
    pub fn mt_announce(&mut self, ids: Vec<u32>) {
        require!(env::predecessor_account_id() == self.operator, "Only the operator");
        for id in ids {
            let Some(co) = self.companies.get(&id) else { continue };
            for h in &co.holders {
                let owner = match (h.company, &h.account) {
                    (None, Some(a)) => a.clone(),
                    (Some(c), _) => match self.companies.get(&c) { Some(p) => p.agent.clone(), None => continue },
                    _ => continue,
                };
                if h.shares > 0 { mt_mint_log(&owner, id, h.shares, "existing"); }
            }
        }
    }
}

impl Valley {
    fn transfer_shares(&mut self, id: u32, to: AccountId, amount: u128, memo: Option<String>) {
        let from = env::predecessor_account_id();
        require!(from != to, "Sender and receiver are the same");
        require!(amount > 0 && amount <= u64::MAX as u128, "Invalid amount");
        let n = amount as u64;
        let co = self.active_mut(id);
        let i = co.holders.iter().position(|h| h.company.is_none() && h.account.as_ref() == Some(&from)).unwrap_or_else(|| env::panic_str("No shares of this company in this account"));
        require!(co.holders[i].shares >= n, "Not enough shares");
        co.holders[i].shares -= n;
        if co.holders[i].shares == 0 { co.holders.remove(i); }
        co.add_holder(None, Some(to.clone()), n);
        let memo = memo.map(|m| format!(",\"memo\":{m:?}")).unwrap_or_default();
        mt_event("mt_transfer", format!("{{\"old_owner_id\":\"{from}\",\"new_owner_id\":\"{to}\",\"token_ids\":[\"{id}\"],\"amounts\":[\"{n}\"]{memo}}}"));
    }
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"agentvalley\",\"version\":\"0.2.0\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

/// The commitment the app publishes for a sealed bid: sha256("round|ref|bid|list|salt"), hex.
pub fn commit_of(round: u64, reference: u32, bid: u128, list: u128, salt: &str) -> String {
    hex(&env::sha256(format!("{round}|{reference}|{bid}|{list}|{salt}").as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_sector(s: &str) -> bool {
    (2..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

#[near]
impl Valley {
    #[init]
    pub fn new(market_ner: U128, operator: AccountId) -> Self {
        Self {
            companies: IterableMap::new(StorageKey::Companies),
            agents: LookupMap::new(StorageKey::Agents),
            rounds: LookupMap::new(StorageKey::Rounds),
            next_id: 0,
            operator,
            market_ner: market_ner.0,
            capital_in: 0,
            external_in: 0,
            external_out: 0,
            orders: LookupMap::new(StorageKey::Orders),
            fuel_treasury: 0,
            tax_treasury: 0,
            tax_bps: 200,
            refund_after_ms: 2 * 3_600_000,
            sales: LookupMap::new(StorageKey::Sales),
            proceeds: LookupMap::new(StorageKey::Proceeds),
        }
    }

    /// Upgrades a contract deployed before company sales existed, keeping every company, order and treasury.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ValleyV3 = env::state_read().unwrap_or_else(|| env::panic_str("No state to migrate"));
        Self {
            companies: old.companies, agents: old.agents, rounds: old.rounds, next_id: old.next_id, operator: old.operator,
            market_ner: old.market_ner, capital_in: old.capital_in, external_in: old.external_in, external_out: old.external_out,
            orders: old.orders, fuel_treasury: old.fuel_treasury, tax_treasury: old.tax_treasury, tax_bps: old.tax_bps, refund_after_ms: old.refund_after_ms,
            sales: LookupMap::new(StorageKey::Sales), proceeds: LookupMap::new(StorageKey::Proceeds),
        }
    }

    /* ---------- companies change hands ---------- */

    /// The owner (or the operator for app companies) hands the company over. The founder's shares go with it.
    pub fn transfer_company(&mut self, id: u32, new_owner: AccountId) {
        let old = self.managed_mut(id).owner.clone();
        self.hand_over(id, &old, &new_owner);
        emit("transfer_company", format!("{{\"id\":{id},\"from\":\"{old}\",\"to\":\"{new_owner}\"}}"));
    }

    /// A buyer pays for a whole company. The payment waits in escrow until the operator completes the sale.
    #[payable]
    pub fn buy_company(&mut self, id: u32, sale_ref: String, new_owner: AccountId) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach the payment");
        require!(!sale_ref.is_empty() && sale_ref.len() <= 64, "Sale reference must be 1 to 64 bytes");
        require!(!self.sales.contains_key(&sale_ref), "This sale is already paid");
        let seller = {
            let co = self.companies.get(&id).unwrap_or_else(|| env::panic_str("Unknown company"));
            require!(co.active, "Company is closed");
            co.owner.clone()
        };
        require!(new_owner != seller, "The buyer already owns this company");
        let buyer = env::predecessor_account_id();
        self.sales.insert(sale_ref.clone(), Sale { sale_ref: sale_ref.clone(), company: id, buyer: buyer.clone(), new_owner: new_owner.clone(), seller: seller.clone(), amount: U128(amount), status: SaleStatus::Paid, paid_ms: env::block_timestamp_ms(), closed_ms: None });
        emit("buy_company", format!("{{\"ref\":{sale_ref:?},\"id\":{id},\"buyer\":\"{buyer}\",\"new_owner\":\"{new_owner}\",\"amount\":\"{amount}\"}}"));
    }

    /// The sale completes: the company passes to the new owner, the price becomes the seller's proceeds.
    /// If the company changed hands since the payment, the sale cannot complete and must be refunded.
    pub fn complete_sale(&mut self, sale_ref: String) {
        self.only_operator();
        let s = self.sales.get(&sale_ref).cloned().unwrap_or_else(|| env::panic_str("Unknown sale"));
        require!(s.status == SaleStatus::Paid, "Sale is not open");
        let owner = self.companies.get(&s.company).map(|c| c.owner.clone()).unwrap_or_else(|| env::panic_str("Unknown company"));
        require!(owner == s.seller, "The company changed hands since this payment; refund it");
        self.hand_over(s.company, &s.seller, &s.new_owner);
        let had = self.proceeds.get(&s.seller).copied().unwrap_or(0);
        self.proceeds.insert(s.seller.clone(), had + s.amount.0);
        let sm = self.sales.get_mut(&sale_ref).unwrap();
        sm.status = SaleStatus::Completed; sm.closed_ms = Some(env::block_timestamp_ms());
        emit("complete_sale", format!("{{\"ref\":{sale_ref:?},\"id\":{},\"seller\":\"{}\",\"new_owner\":\"{}\",\"amount\":\"{}\"}}", s.company, s.seller, s.new_owner, s.amount.0));
    }

    /// The sale did not happen: the buyer gets the whole payment back.
    pub fn refund_sale(&mut self, sale_ref: String) -> Promise {
        self.only_operator();
        self.refund_sale_inner(sale_ref)
    }

    /// The buyer takes the payment back when the sale was not completed in time.
    pub fn claim_sale_refund(&mut self, sale_ref: String) -> Promise {
        let s = self.sales.get(&sale_ref).cloned().unwrap_or_else(|| env::panic_str("Unknown sale"));
        require!(env::predecessor_account_id() == s.buyer, "Only the buyer can claim the refund");
        require!(env::block_timestamp_ms() >= s.paid_ms + self.refund_after_ms, "The sale still has time to complete");
        self.refund_sale_inner(sale_ref)
    }

    /// A seller takes what their company sales brought in.
    pub fn claim_proceeds(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.proceeds.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "Nothing to claim");
        self.proceeds.remove(&who);
        emit("claim_proceeds", format!("{{\"account\":\"{who}\",\"amount\":\"{amount}\"}}"));
        Promise::new(who).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn get_sale(&self, sale_ref: String) -> Option<Sale> {
        self.sales.get(&sale_ref).cloned()
    }

    pub fn proceeds_of(&self, account: AccountId) -> U128 {
        U128(self.proceeds.get(&account).copied().unwrap_or(0))
    }

    /* ---------- customer orders: escrow and automatic split ---------- */

    /// A customer pays for a job. The NEAR stays in escrow here until the order is settled or refunded.
    #[payable]
    pub fn place_order(&mut self, company: u32, order_ref: String) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach the payment");
        require!(!order_ref.is_empty() && order_ref.len() <= 64, "Order reference must be 1 to 64 bytes");
        require!(!self.orders.contains_key(&order_ref), "This order is already paid");
        require!(self.companies.get(&company).map(|c| c.active && !c.paused).unwrap_or(false), "Company is not taking orders");
        let customer = env::predecessor_account_id();
        let order = Order { order_ref: order_ref.clone(), company, customer: customer.clone(), amount: U128(amount), status: OrderStatus::Paid, paid_ms: env::block_timestamp_ms(), closed_ms: None, fuel: U128(0), parts: U128(0), tax: U128(0), profit: U128(0) };
        self.orders.insert(order_ref.clone(), order);
        emit("place_order", format!("{{\"ref\":{order_ref:?},\"company\":{company},\"customer\":\"{customer}\",\"amount\":\"{amount}\"}}"));
    }

    /// The job was delivered: the payment becomes the company's revenue and this contract splits it.
    /// fuel: the model bill paid with the platform's credit. parts: what supplier agents earned for their parts.
    /// The tax is tax_bps of what is left; the rest stays with the company.
    pub fn settle_order(&mut self, order_ref: String, fuel: U128, parts: Vec<PartPay>) {
        self.only_operator();
        let o = self.orders.get(&order_ref).cloned().unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(o.status == OrderStatus::Paid, "Order is not open");
        let parts_sum: u128 = parts.iter().map(|p| p.amount.0).sum();
        require!(fuel.0 + parts_sum <= o.amount.0, "Fuel and parts exceed the payment");
        for p in &parts {
            require!(p.company != o.company, "A company cannot be its own supplier");
            require!(self.companies.get(&p.company).map(|c| c.active).unwrap_or(false), "Supplier must be an active company");
        }
        let profit = o.amount.0 - fuel.0 - parts_sum;
        let tax = profit * self.tax_bps as u128 / 10_000;
        let market_ner = self.market_ner;
        // The whole payment is outside money for the company: earned and NER, like pay().
        {
            let co = self.active_mut(o.company);
            co.earned = U128(co.earned.0 + o.amount.0);
            co.ner = U128(co.ner.0 + o.amount.0);
            co.earned = U128(co.earned.0 - parts_sum - fuel.0 - tax);
            co.ner = U128(co.ner.0 - parts_sum);
        }
        self.external_in += o.amount.0;
        // Parts move to the suppliers with their NER, like trade(); fuel and tax leave for the treasuries.
        for p in &parts {
            let s = self.companies.get_mut(&p.company).unwrap();
            s.earned = U128(s.earned.0 + p.amount.0);
            s.ner = U128(s.ner.0 + p.amount.0);
            s.rep.parts_delivered += 1;
            s.rep.volume_sold = U128(s.rep.volume_sold.0 + p.amount.0);
        }
        self.fuel_treasury += fuel.0;
        self.tax_treasury += tax;
        self.external_out += fuel.0 + tax;
        let promoted = promote(self.companies.get_mut(&o.company).unwrap(), market_ner);
        let om = self.orders.get_mut(&order_ref).unwrap();
        om.status = OrderStatus::Settled; om.closed_ms = Some(env::block_timestamp_ms());
        om.fuel = fuel; om.parts = U128(parts_sum); om.tax = U128(tax); om.profit = U128(profit - tax);
        emit("settle_order", format!("{{\"ref\":{order_ref:?},\"company\":{},\"amount\":\"{}\",\"fuel\":\"{}\",\"parts\":\"{parts_sum}\",\"tax\":\"{tax}\",\"profit\":\"{}\"}}", o.company, o.amount.0, fuel.0, profit - tax));
        if let Some(stage) = promoted {
            emit("stage", format!("{{\"id\":{},\"stage\":\"{stage}\"}}", o.company));
        }
    }

    /// The job failed: the customer gets the whole payment back.
    pub fn refund_order(&mut self, order_ref: String) -> Promise {
        self.only_operator();
        self.refund(order_ref)
    }

    /// The customer takes the money back when the order was not settled in time. No one has to agree.
    pub fn claim_refund(&mut self, order_ref: String) -> Promise {
        let o = self.orders.get(&order_ref).cloned().unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(env::predecessor_account_id() == o.customer, "Only the customer can claim the refund");
        require!(env::block_timestamp_ms() >= o.paid_ms + self.refund_after_ms, "The agent still has time to deliver");
        self.refund(order_ref)
    }

    /// Moves treasury money out, for example fuel to buy model credit.
    pub fn withdraw_treasury(&mut self, kind: String, amount: U128, to: AccountId) -> Promise {
        self.only_operator();
        let pot = match kind.as_str() { "fuel" => &mut self.fuel_treasury, "tax" => &mut self.tax_treasury, _ => env::panic_str("Kind is fuel or tax") };
        require!(amount.0 > 0 && amount.0 <= *pot, "Not that much in the treasury");
        *pot -= amount.0;
        emit("withdraw_treasury", format!("{{\"kind\":{kind:?},\"amount\":\"{}\",\"to\":\"{to}\"}}", amount.0));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn get_order(&self, order_ref: String) -> Option<Order> {
        self.orders.get(&order_ref).cloned()
    }

    pub fn treasury(&self) -> Treasury {
        Treasury { fuel: U128(self.fuel_treasury), tax: U128(self.tax_treasury), tax_bps: self.tax_bps, refund_after_ms: self.refund_after_ms }
    }

    /// Opens a company and issues its agent card and shares. The deposit pays for storage; the rest is seed capital.
    /// The operator may found on behalf of an `owner`; anyone else founds for themselves.
    #[payable]
    pub fn found(&mut self, name: String, sector: String, agent: AccountId, card: Card, charter: Charter, owner: Option<AccountId>) -> u32 {
        let deposit = env::attached_deposit().as_yoctonear();
        let caller = env::predecessor_account_id();
        require!(name.len() >= 2 && name.len() <= 32, "Name must be 2 to 32 bytes");
        require!(valid_sector(&sector), "Sector must be a 2 to 32 character slug");
        require!(card.model.len() <= 96 && card.uri.len() <= 256, "Card fields too long");
        require!(owner.is_none() || caller == self.operator, "Only the operator founds for someone else");
        require!(charter.founder_bps > 0 && charter.founder_bps as u32 + charter.sale_bps as u32 <= 10_000, "Founder and sale shares must leave a valid split");
        require!(charter.sale_bps == 0 || charter.share_price.0 > 0, "Shares for sale need a price");
        require!(!self.agents.contains_key(&agent), "This agent already has an Agent ID");
        let owner = owner.unwrap_or(caller);
        let supply = charter.supply.map(|s| s.0).unwrap_or(DEFAULT_SUPPLY);
        require!(supply >= MIN_SUPPLY, "A company needs at least 100 shares");
        let founder = (supply as u128 * charter.founder_bps as u128 / 10_000) as u64;
        let for_sale = (supply as u128 * charter.sale_bps as u128 / 10_000) as u64;
        let id = self.next_id;
        let before = env::storage_usage();
        let co = Company {
            id,
            ref_id: card.ref_id,
            name: name.clone(),
            sector: sector.clone(),
            model: card.model,
            card_uri: card.uri,
            stage: Stage::Idea,
            owner: owner.clone(),
            agent: agent.clone(),
            earned: U128(0),
            capital: U128(0),
            ner: U128(0),
            seed: U128(0),
            raised: U128(0),
            daily_limit: U128(0),
            spent_today: U128(0),
            spend_day: 0,
            allow: Vec::new(),
            share_price: charter.share_price,
            for_sale,
            pool: supply - founder - for_sale,
            holders: vec![Holder { company: None, account: Some(owner.clone()), shares: founder }],
            rep: Reputation::default(),
            paused: false,
            active: true,
            created_ms: env::block_timestamp_ms(),
        };
        self.companies.insert(id, co);
        self.agents.insert(agent.clone(), id);
        self.companies.flush();
        self.agents.flush();
        let used = (env::storage_usage() - before) as u128 + 800;
        let storage_cost = used * env::storage_byte_cost().as_yoctonear();
        require!(deposit >= storage_cost + MIN_SEED, "Deposit must cover storage plus 0.01 NEAR seed");
        let seed = deposit - storage_cost;
        let co = self.companies.get_mut(&id).unwrap();
        co.capital = U128(seed);
        co.seed = U128(seed);
        self.capital_in += seed;
        self.next_id += 1;
        emit("found", format!("{{\"id\":{id},\"name\":{name:?},\"sector\":{sector:?},\"owner\":\"{owner}\",\"agent\":\"{agent}\",\"seed\":\"{seed}\",\"supply\":{supply},\"founder_shares\":{founder},\"for_sale\":{for_sale}}}"));
        if founder > 0 { mt_mint_log(&owner, id, founder, "founder"); }
        id
    }

    /// Updates the agent card.
    pub fn set_card(&mut self, id: u32, model: String, uri: String) {
        require!(model.len() <= 96 && uri.len() <= 256, "Card fields too long");
        let co = self.managed_mut(id);
        co.model = model;
        co.card_uri = uri;
        emit("card", format!("{{\"id\":{id}}}"));
    }

    /// Sets the agent's daily spend limit and the outside accounts it may pay.
    pub fn set_limits(&mut self, id: u32, daily_limit: U128, allow: Vec<AccountId>) {
        require!(allow.len() <= MAX_ALLOW, "Too many allowed receivers");
        let co = self.managed_mut(id);
        co.daily_limit = daily_limit;
        co.allow = allow;
    }

    /// Kill switch for the agent.
    pub fn set_paused(&mut self, id: u32, paused: bool) {
        self.managed_mut(id).paused = paused;
    }

    /// An outside customer pays a company. This is the only way NER is created.
    #[payable]
    pub fn pay(&mut self, id: u32) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach a payment");
        let market_ner = self.market_ner;
        let co = self.active_mut(id);
        co.earned = U128(co.earned.0 + amount);
        co.ner = U128(co.ner.0 + amount);
        let promoted = promote(co, market_ner);
        self.external_in += amount;
        emit("pay", format!("{{\"id\":{id},\"from\":\"{}\",\"amount\":\"{amount}\"}}", env::predecessor_account_id()));
        if let Some(stage) = promoted {
            emit("stage", format!("{{\"id\":{id},\"stage\":\"{stage}\"}}"));
        }
    }

    /// An agent company buys shares of another company and becomes a partner. Only registered agents can buy, and
    /// they pay from their capital, so an investment ring cannot raise NER.
    pub fn buy_shares(&mut self, id: u32, buyer: u32, shares: u64) {
        require!(id != buyer, "A company cannot buy its own shares");
        require!(shares > 0, "Buy at least one share");
        let caller = env::predecessor_account_id();
        let cost = {
            let target = self.companies.get(&id).unwrap_or_else(|| env::panic_str("Unknown company"));
            require!(target.active, "Company is closed");
            require!(shares <= target.for_sale, "Not that many shares for sale");
            target.share_price.0.checked_mul(shares as u128).unwrap_or_else(|| env::panic_str("Price overflow"))
        };
        {
            let operator = self.operator.clone();
            let b = self.active_mut(buyer);
            require!(caller == b.agent || caller == b.owner || caller == operator, "Only the buying company's agent or owner can buy");
            require!(!b.paused || caller != b.agent, "Agent is paused");
            require!(b.capital.0 >= cost, "Shares are paid from capital, and there is not enough");
            b.capital = U128(b.capital.0 - cost);
        }
        let market_ner = self.market_ner;
        let t = self.active_mut(id);
        t.capital = U128(t.capital.0 + cost);
        t.raised = U128(t.raised.0 + cost);
        t.for_sale -= shares;
        t.add_holder(Some(buyer), None, shares);
        let promoted = promote(t, market_ner);
        emit("buy_shares", format!("{{\"id\":{id},\"buyer\":{buyer},\"shares\":{shares},\"cost\":\"{cost}\"}}"));
        if let Some(b) = self.companies.get(&buyer) { mt_mint_log(&b.agent, id, shares, "bought by agent"); }
        if let Some(stage) = promoted {
            emit("stage", format!("{{\"id\":{id},\"stage\":\"{stage}\"}}"));
        }
    }

    /// Grants shares from the ecosystem pool to a partner agent, for example a supplier the company relies on.
    pub fn grant_shares(&mut self, id: u32, to: u32, shares: u64) {
        require!(id != to, "A company cannot grant shares to itself");
        require!(shares > 0, "Grant at least one share");
        require!(self.companies.get(&to).map(|c| c.active).unwrap_or(false), "Shares go only to active agent companies");
        let co = self.managed_mut(id);
        require!(co.active, "Company is closed");
        require!(shares <= co.pool, "Not that many shares in the pool");
        co.pool -= shares;
        co.add_holder(Some(to), None, shares);
        emit("grant_shares", format!("{{\"id\":{id},\"to\":{to},\"shares\":{shares}}}"));
        if let Some(b) = self.companies.get(&to) { mt_mint_log(&b.agent, id, shares, "granted"); }
    }

    /// Pays a dividend from earned money to the shareholders, by shares held. Partner companies receive it as
    /// earned money with its NER; a founder account receives NEAR.
    pub fn distribute(&mut self, id: u32, amount: U128) -> PromiseOrValue<()> {
        require!(amount.0 > 0, "Amount must be positive");
        let (holders, held) = {
            let co = self.managed_mut(id);
            require!(co.active, "Company is closed");
            require!(amount.0 <= co.earned.0, "Dividends come from earned money only");
            co.earned = U128(co.earned.0 - amount.0);
            (co.holders.clone(), co.held())
        };
        let parts = split(amount.0, &holders, held);
        let mut moved_ner = 0u128;
        let mut payout: Option<Promise> = None;
        for (h, part) in holders.iter().zip(parts) {
            if part == 0 {
                continue;
            }
            match (h.company, &h.account) {
                (Some(cid), _) => {
                    let p = self.companies.get_mut(&cid).unwrap_or_else(|| env::panic_str("Unknown holder"));
                    p.earned = U128(p.earned.0 + part);
                    p.ner = U128(p.ner.0 + part);
                    moved_ner += part;
                }
                (None, Some(acc)) => {
                    self.external_out += part;
                    let p = Promise::new(acc.clone()).transfer(NearToken::from_yoctonear(part));
                    payout = Some(match payout { Some(prev) => prev.and(p), None => p });
                }
                _ => {}
            }
        }
        let co = self.companies.get_mut(&id).unwrap();
        co.ner = U128(co.ner.0 - moved_ner);
        emit("distribute", format!("{{\"id\":{id},\"amount\":\"{}\"}}", amount.0));
        match payout {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(()),
        }
    }

    /// The agent of `from` buys from another company. The earned part moves with its NER.
    pub fn trade(&mut self, from: u32, to: u32, amount: U128) {
        require!(from != to, "A company cannot trade with itself");
        require!(amount.0 > 0, "Amount must be positive");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let market_ner = self.market_ner;
        let (e, c) = {
            let src = self.active_mut(from);
            require!(src.agent == caller, "Only the company agent can trade");
            require!(!src.paused, "Agent is paused");
            src.charge_limit(amount.0, now);
            let (e, c) = src.take(amount.0);
            src.ner = U128(src.ner.0 - e);
            (e, c)
        };
        let dst = self.active_mut(to);
        dst.earned = U128(dst.earned.0 + e);
        dst.capital = U128(dst.capital.0 + c);
        dst.ner = U128(dst.ner.0 + e);
        let promoted = promote(dst, market_ner);
        emit("trade", format!("{{\"from\":{from},\"to\":{to},\"amount\":\"{}\",\"earned\":\"{e}\"}}", amount.0));
        if let Some(stage) = promoted {
            emit("stage", format!("{{\"id\":{to},\"stage\":\"{stage}\"}}"));
        }
    }

    /// The agent pays an allowed outside account, for example an inference provider.
    pub fn spend(&mut self, id: u32, amount: U128, receiver: AccountId) -> Promise {
        require!(amount.0 > 0, "Amount must be positive");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let co = self.active_mut(id);
        require!(co.agent == caller, "Only the company agent can spend");
        require!(!co.paused, "Agent is paused");
        require!(co.allow.contains(&receiver), "Receiver is not on the allow list");
        co.charge_limit(amount.0, now);
        co.take(amount.0);
        self.external_out += amount.0;
        emit("spend", format!("{{\"id\":{id},\"to\":\"{receiver}\",\"amount\":\"{}\"}}", amount.0));
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0))
    }

    /* ---------- sealed part auctions ---------- */

    /// The operator lists a part a company needs.
    pub fn open_round(&mut self, round: u64, buyer: u32, sector: String, closes_ms: u64) {
        self.only_operator();
        require!(!self.rounds.contains_key(&round), "Round already exists");
        require!(valid_sector(&sector), "Sector must be a 2 to 32 character slug");
        require!(self.companies.get(&buyer).map(|c| c.active).unwrap_or(false), "Buyer must be an active company");
        let now = env::block_timestamp_ms();
        self.rounds.insert(round, Round { id: round, buyer, sector: sector.clone(), opened_ms: now, closes_ms, seals: vec![], bids: vec![], winner: None, price: None, closed: false });
        emit("open_round", format!("{{\"round\":{round},\"buyer\":{buyer},\"sector\":{sector:?},\"closes_ms\":{closes_ms}}}"));
    }

    /// A supplier's sealed bid: only the commitment goes on chain. Its agent or the operator may seal it.
    pub fn seal(&mut self, round: u64, company: u32, commit: String) {
        let caller = env::predecessor_account_id();
        require!(commit.len() == 64 && commit.bytes().all(|b| b.is_ascii_hexdigit()), "Commit must be a sha256 hex digest");
        let (sector, agent, active) = {
            let co = self.companies.get(&company).unwrap_or_else(|| env::panic_str("Unknown company"));
            (co.sector.clone(), co.agent.clone(), co.active)
        };
        require!(caller == agent || caller == self.operator, "Only the supplier's agent or the operator can seal");
        let r = self.rounds.get_mut(&round).unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(!r.closed, "Round is closed");
        require!(active && sector == r.sector && company != r.buyer, "Only an active supplier in the round's sector can bid");
        require!(r.seals.len() < MAX_SEALS, "Too many bids");
        require!(!r.seals.iter().any(|s| s.company == company), "This supplier already sealed a bid");
        r.seals.push(Seal { company, commit: commit.clone(), at_ms: env::block_timestamp_ms() });
        emit("seal", format!("{{\"round\":{round},\"company\":{company},\"commit\":\"{commit}\"}}"));
    }

    /// Reveals the bids after the round closed. Every reveal must match its seal. This contract, not the operator,
    /// picks the winner: lowest bid, ties to the earlier seal; price is the second-lowest bid capped at the winner's
    /// list price, or the list price when only one supplier bid. A sealed bid that is not revealed drops out.
    pub fn reveal(&mut self, round: u64, reveals: Vec<Reveal>) -> Option<u32> {
        self.only_operator();
        let now = env::block_timestamp_ms();
        let r = self.rounds.get(&round).cloned().unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(!r.closed, "Round is already closed");
        require!(now >= r.closes_ms, "Round is still open");
        let mut bids: Vec<(u64, Bid)> = vec![];
        for rv in reveals {
            let seal = r.seals.iter().find(|s| s.company == rv.company).unwrap_or_else(|| env::panic_str("No sealed bid from this company"));
            require!(!bids.iter().any(|(_, b)| b.company == rv.company), "Duplicate reveal");
            let co = self.companies.get(&rv.company).unwrap();
            let reference = co.ref_id.unwrap_or(co.id);
            require!(commit_of(round, reference, rv.bid.0, rv.list.0, &rv.salt) == seal.commit, "Reveal does not match the sealed bid");
            bids.push((seal.at_ms, Bid { company: rv.company, bid: rv.bid, list: rv.list }));
        }
        let mut ranked = bids.clone();
        ranked.sort_by(|a, b| a.1.bid.0.cmp(&b.1.bid.0).then(a.0.cmp(&b.0)).then(a.1.company.cmp(&b.1.company)));
        let winner = ranked.first().map(|(_, b)| b.clone());
        let price = winner.as_ref().map(|w| if ranked.len() > 1 { ranked[1].1.bid.0.min(w.list.0) } else { w.list.0 });
        for (_, b) in &bids {
            if let Some(co) = self.companies.get_mut(&b.company) {
                co.rep.auctions_bid += 1;
            }
        }
        if let Some(w) = &winner {
            if let Some(co) = self.companies.get_mut(&w.company) {
                co.rep.auctions_won += 1;
            }
        }
        let rm = self.rounds.get_mut(&round).unwrap();
        rm.bids = bids.into_iter().map(|(_, b)| b).collect();
        rm.winner = winner.as_ref().map(|w| w.company);
        rm.price = price.map(U128);
        rm.closed = true;
        let w = rm.winner.map(|w| w.to_string()).unwrap_or_else(|| "null".into());
        let p = price.map(|p| format!("\"{p}\"")).unwrap_or_else(|| "null".into());
        emit("reveal", format!("{{\"round\":{round},\"winner\":{w},\"price\":{p},\"bids\":{}}}", rm.bids.len()));
        rm.winner
    }

    /// The operator records a delivered part, which builds both companies' reputation.
    pub fn record_delivery(&mut self, seller: u32, buyer: u32, amount: U128, round: Option<u64>) {
        self.only_operator();
        require!(seller != buyer, "A company cannot sell to itself");
        if let Some(rid) = round {
            let r = self.rounds.get(&rid).unwrap_or_else(|| env::panic_str("Unknown round"));
            require!(r.closed && r.winner == Some(seller) && r.buyer == buyer, "Delivery does not match the round");
        }
        {
            let s = self.companies.get_mut(&seller).unwrap_or_else(|| env::panic_str("Unknown seller"));
            s.rep.parts_delivered += 1;
            s.rep.volume_sold = U128(s.rep.volume_sold.0 + amount.0);
        }
        let b = self.companies.get_mut(&buyer).unwrap_or_else(|| env::panic_str("Unknown buyer"));
        b.rep.parts_bought += 1;
        b.rep.volume_bought = U128(b.rep.volume_bought.0 + amount.0);
        emit("delivery", format!("{{\"seller\":{seller},\"buyer\":{buyer},\"amount\":\"{}\"}}", amount.0));
    }

    /// Closes a company and pays out what is left to its shareholders by shares held. Partner companies receive
    /// their part inside the valley, earned money with its NER; a founder account receives NEAR.
    pub fn close(&mut self, id: u32) -> PromiseOrValue<()> {
        let (holders, held, e, c) = {
            let co = self.managed_mut(id);
            require!(co.active, "Company is already closed");
            let left = co.balance();
            let (e, c) = co.take(left);
            co.active = false;
            (co.holders.clone(), co.held(), e, c)
        };
        let pe = split(e, &holders, held);
        let pc = split(c, &holders, held);
        let mut moved_ner = 0u128;
        let mut out = 0u128;
        let mut payout: Option<Promise> = None;
        for ((h, ep), cp) in holders.iter().zip(pe).zip(pc) {
            match (h.company, &h.account) {
                (Some(cid), _) => {
                    let p = self.companies.get_mut(&cid).unwrap_or_else(|| env::panic_str("Unknown holder"));
                    p.earned = U128(p.earned.0 + ep);
                    p.capital = U128(p.capital.0 + cp);
                    p.ner = U128(p.ner.0 + ep);
                    moved_ner += ep;
                }
                (None, Some(acc)) if ep + cp > 0 => {
                    out += ep + cp;
                    let p = Promise::new(acc.clone()).transfer(NearToken::from_yoctonear(ep + cp));
                    payout = Some(match payout { Some(prev) => prev.and(p), None => p });
                }
                _ => {}
            }
        }
        self.external_out += out;
        let co = self.companies.get_mut(&id).unwrap();
        co.ner = U128(co.ner.0 - moved_ner);
        emit("close", format!("{{\"id\":{id},\"paid_out\":\"{out}\",\"to_partners\":\"{}\"}}", e + c - out));
        match payout {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(()),
        }
    }

    /* ---------- views ---------- */

    pub fn get_company(&self, id: u32) -> Option<Company> {
        self.companies.get(&id).cloned()
    }

    /// Agent ID lookup: which company an agent account belongs to.
    pub fn agent_id(&self, account: AccountId) -> Option<u32> {
        self.agents.get(&account).copied()
    }

    pub fn get_round(&self, round: u64) -> Option<Round> {
        self.rounds.get(&round).cloned()
    }

    pub fn list_companies(&self, from: u32, limit: u32) -> Vec<Company> {
        self.companies.values().skip(from as usize).take(limit.min(50) as usize).cloned().collect()
    }

    pub fn operator(&self) -> AccountId {
        self.operator.clone()
    }

    pub fn stats(&self) -> Stats {
        let mut ner_sum = 0u128;
        let mut balance_sum = 0u128;
        for co in self.companies.values() {
            ner_sum += co.ner.0;
            balance_sum += co.balance();
        }
        Stats {
            companies: self.next_id,
            capital_in: U128(self.capital_in),
            external_in: U128(self.external_in),
            external_out: U128(self.external_out),
            ner_sum: U128(ner_sum),
            balance_sum: U128(balance_sum),
            ner_ok: ner_sum == self.external_in,
            balance_ok: balance_sum == self.capital_in + self.external_in - self.external_out,
        }
    }
}

impl Valley {
    fn active_mut(&mut self, id: u32) -> &mut Company {
        let co = self.companies.get_mut(&id).unwrap_or_else(|| env::panic_str("Unknown company"));
        require!(co.active, "Company is closed");
        co
    }

    /// The owner or the operator, which runs companies founded through the app.
    fn managed_mut(&mut self, id: u32) -> &mut Company {
        let caller = env::predecessor_account_id();
        let operator = self.operator.clone();
        let co = self.companies.get_mut(&id).unwrap_or_else(|| env::panic_str("Unknown company"));
        require!(co.owner == caller || caller == operator, "Only the owner can do this");
        co
    }

    /// The company and the founder's shares pass from one owner to another.
    fn hand_over(&mut self, id: u32, old: &AccountId, new_owner: &AccountId) {
        let co = self.companies.get_mut(&id).unwrap_or_else(|| env::panic_str("Unknown company"));
        require!(co.active, "Company is closed");
        require!(new_owner != old, "Already the owner");
        co.owner = new_owner.clone();
        // The founder's shares go with the company; if the new owner already held some, the two lines merge.
        if let Some(i) = co.holders.iter().position(|h| h.company.is_none() && h.account.as_ref() == Some(old)) {
            let n = co.holders.remove(i).shares;
            co.add_holder(None, Some(new_owner.clone()), n);
            mt_event("mt_transfer", format!("{{\"old_owner_id\":\"{old}\",\"new_owner_id\":\"{new_owner}\",\"token_ids\":[\"{id}\"],\"amounts\":[\"{n}\"],\"memo\":\"company handed over\"}}"));
        }
    }

    fn refund_sale_inner(&mut self, sale_ref: String) -> Promise {
        let s = self.sales.get_mut(&sale_ref).unwrap_or_else(|| env::panic_str("Unknown sale"));
        require!(s.status == SaleStatus::Paid, "Sale is not open");
        s.status = SaleStatus::Refunded;
        s.closed_ms = Some(env::block_timestamp_ms());
        let (to, amount) = (s.buyer.clone(), s.amount.0);
        emit("refund_sale", format!("{{\"ref\":{sale_ref:?},\"buyer\":\"{to}\",\"amount\":\"{amount}\"}}"));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
    }

    fn refund(&mut self, order_ref: String) -> Promise {
        let o = self.orders.get_mut(&order_ref).unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(o.status == OrderStatus::Paid, "Order is not open");
        o.status = OrderStatus::Refunded;
        o.closed_ms = Some(env::block_timestamp_ms());
        let (to, amount) = (o.customer.clone(), o.amount.0);
        emit("refund_order", format!("{{\"ref\":{order_ref:?},\"customer\":\"{to}\",\"amount\":\"{amount}\"}}"));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
    }

    fn only_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "Only the operator can do this");
    }
}

/// Splits `amount` by shares held; the last holder takes the rounding remainder so nothing is lost.
fn split(amount: u128, holders: &[Holder], held: u64) -> Vec<u128> {
    let mut parts = vec![0u128; holders.len()];
    if held == 0 || holders.is_empty() {
        return parts;
    }
    let mut paid = 0u128;
    let last = holders.iter().rposition(|h| h.shares > 0).unwrap_or(holders.len() - 1);
    for (i, h) in holders.iter().enumerate() {
        if i == last {
            parts[i] = amount - paid;
            break;
        }
        parts[i] = mul_div(amount, h.shares as u128, held as u128);
        paid += parts[i];
    }
    parts
}

/// a * b / c without overflow: yoctoNEAR amounts multiplied together exceed u128.
fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    require!(c > 0, "Division by zero");
    let (hi, lo) = mul_wide(a, b);
    let (mut q, mut r) = (0u128, 0u128);
    for i in (0..256).rev() {
        let bit = if i >= 128 { (hi >> (i - 128)) & 1 } else { (lo >> i) & 1 };
        let carry = r >> 127;
        r = (r << 1) | bit;
        if carry == 1 || r >= c {
            r = r.wrapping_sub(c);
            require!(i < 128, "Result does not fit in u128");
            q |= 1u128 << i;
        }
    }
    q
}

fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & mask);
    let (b1, b0) = (b >> 64, b & mask);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & mask) + (p10 & mask);
    let lo = (p00 & mask) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// Stages only move forward: workshop, company after funding, headquarters once NER is real.
fn promote(co: &mut Company, market_ner: u128) -> Option<&'static str> {
    let before = co.stage;
    if co.stage == Stage::Idea && co.raised.0 > 0 {
        co.stage = Stage::Funded;
    }
    if co.stage == Stage::Funded && co.ner.0 >= market_ner {
        co.stage = Stage::Market;
    }
    if co.stage == before {
        return None;
    }
    Some(match co.stage {
        Stage::Idea => "idea",
        Stage::Funded => "funded",
        Stage::Market => "market",
    })
}

#[cfg(test)]
mod tests;
