//! Agent Valley: company registry and net external revenue (NER) ledger.
//!
//! Every company holds real NEAR in two buckets:
//! - `earned`: money that traces back to an outside customer
//! - `capital`: seed money and investment
//!
//! Customer payments add NER. Trades between companies move the earned part of a
//! payment and the NER that goes with it. Capital never creates NER, so a ring of
//! agents paying each other cannot raise the total.
//!
//! Invariants, checked by `stats()` and the tests:
//! 1. sum(ner) == external_in
//! 2. sum(earned + capital) == capital_in + external_in - external_out

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const MIN_SEED: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const DAY_NS: u64 = 86_400_000_000_000;
const MAX_ALLOW: usize = 10;
const MAX_HOLDERS: usize = 12;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Sector {
    Visual,
    Web,
    Security,
    Social,
    Research,
    Software,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Idea,
    Funded,
    Market,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Holder {
    pub account: AccountId,
    /// Share of the company in basis points.
    pub bps: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Company {
    pub id: u32,
    pub name: String,
    pub sector: Sector,
    pub stage: Stage,
    /// Human who founded the company and sets its limits.
    pub owner: AccountId,
    /// Agent account allowed to trade and spend for the company.
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
    pub holders: Vec<Holder>,
    pub paused: bool,
    pub active: bool,
    pub created_ms: u64,
}

impl Company {
    fn balance(&self) -> u128 {
        self.earned.0 + self.capital.0
    }

    /// Takes `amount` pro rata from both buckets, like the simulator does.
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
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Valley {
    companies: IterableMap<u32, Company>,
    next_id: u32,
    /// NER a funded company needs before it moves to its headquarters.
    market_ner: u128,
    capital_in: u128,
    external_in: u128,
    external_out: u128,
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"agentvalley\",\"version\":\"0.1.0\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

#[near]
impl Valley {
    #[init]
    pub fn new(market_ner: U128) -> Self {
        Self {
            companies: IterableMap::new(StorageKey::Companies),
            next_id: 0,
            market_ner: market_ner.0,
            capital_in: 0,
            external_in: 0,
            external_out: 0,
        }
    }

    /// Opens a workshop. The attached deposit pays for storage; the rest is seed capital.
    #[payable]
    pub fn found(&mut self, name: String, sector: Sector, agent: AccountId) -> u32 {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(name.len() >= 2 && name.len() <= 32, "Name must be 2 to 32 bytes");
        let owner = env::predecessor_account_id();
        let id = self.next_id;
        let before = env::storage_usage();
        let co = Company {
            id,
            name: name.clone(),
            sector,
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
            holders: vec![Holder { account: owner.clone(), bps: 10_000 }],
            paused: false,
            active: true,
            created_ms: env::block_timestamp_ms(),
        };
        self.companies.insert(id, co);
        self.companies.flush();
        let used = (env::storage_usage() - before) as u128 + 600;
        let storage_cost = used * env::storage_byte_cost().as_yoctonear();
        require!(deposit >= storage_cost + MIN_SEED, "Deposit must cover storage plus 0.1 NEAR seed");
        let seed = deposit - storage_cost;
        let co = self.companies.get_mut(&id).unwrap();
        co.capital = U128(seed);
        co.seed = U128(seed);
        self.capital_in += seed;
        self.next_id += 1;
        emit("found", format!("{{\"id\":{id},\"name\":{:?},\"sector\":{:?},\"owner\":\"{owner}\",\"agent\":\"{agent}\",\"seed\":\"{seed}\"}}", name, format!("{:?}", sector).to_lowercase()));
        id
    }

    /// Sets the agent's daily spend limit and the outside accounts it may pay.
    pub fn set_limits(&mut self, id: u32, daily_limit: U128, allow: Vec<AccountId>) {
        require!(allow.len() <= MAX_ALLOW, "Too many allowed receivers");
        let co = self.owned_mut(id);
        co.daily_limit = daily_limit;
        co.allow = allow;
    }

    /// Kill switch for the agent.
    pub fn set_paused(&mut self, id: u32, paused: bool) {
        self.owned_mut(id).paused = paused;
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

    /// An investor buys a share. The money goes to capital and creates no NER.
    #[payable]
    pub fn invest(&mut self, id: u32, valuation: U128) -> u32 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach the investment");
        require!(valuation.0 > 0, "Valuation must be positive");
        let investor = env::predecessor_account_id();
        let market_ner = self.market_ner;
        let co = self.active_mut(id);
        let stake = ((amount * 10_000) / (valuation.0 + amount)) as u32;
        require!(stake > 0, "Investment too small for one basis point");
        for h in co.holders.iter_mut() {
            h.bps = ((h.bps as u64) * (10_000 - stake as u64) / 10_000) as u32;
        }
        match co.holders.iter_mut().find(|h| h.account == investor) {
            Some(h) => h.bps += stake,
            None => {
                require!(co.holders.len() < MAX_HOLDERS, "Too many shareholders");
                co.holders.push(Holder { account: investor.clone(), bps: stake });
            }
        }
        co.capital = U128(co.capital.0 + amount);
        co.raised = U128(co.raised.0 + amount);
        let promoted = promote(co, market_ner);
        self.capital_in += amount;
        emit("invest", format!("{{\"id\":{id},\"investor\":\"{investor}\",\"amount\":\"{amount}\",\"bps\":{stake}}}"));
        if let Some(stage) = promoted {
            emit("stage", format!("{{\"id\":{id},\"stage\":\"{stage}\"}}"));
        }
        stake
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

    /// Closes a company and pays out what is left to its shareholders.
    pub fn close(&mut self, id: u32) -> PromiseOrValue<()> {
        let co = self.owned_mut(id);
        require!(co.active, "Company is already closed");
        let left = co.balance();
        co.take(left);
        co.active = false;
        let holders = co.holders.clone();
        let total_bps: u64 = holders.iter().map(|h| h.bps as u64).sum();
        let mut paid = 0u128;
        let mut payout: Option<Promise> = None;
        for (i, h) in holders.iter().enumerate() {
            let part = if i + 1 == holders.len() { left - paid } else { mul_div(left, h.bps as u128, total_bps.max(1) as u128) };
            paid += part;
            if part > 0 {
                let p = Promise::new(h.account.clone()).transfer(NearToken::from_yoctonear(part));
                payout = Some(match payout { Some(prev) => prev.and(p), None => p });
            }
        }
        self.external_out += left;
        emit("close", format!("{{\"id\":{id},\"paid_out\":\"{left}\"}}"));
        match payout {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(()),
        }
    }

    pub fn get_company(&self, id: u32) -> Option<Company> {
        self.companies.get(&id).cloned()
    }

    pub fn list_companies(&self, from: u32, limit: u32) -> Vec<Company> {
        self.companies.values().skip(from as usize).take(limit.min(50) as usize).cloned().collect()
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

    fn owned_mut(&mut self, id: u32) -> &mut Company {
        let caller = env::predecessor_account_id();
        let co = self.companies.get_mut(&id).unwrap_or_else(|| env::panic_str("Unknown company"));
        require!(co.owner == caller, "Only the owner can do this");
        co
    }
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
