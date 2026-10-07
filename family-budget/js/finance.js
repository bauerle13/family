export const CATEGORIES = [
  'Income', 'Housing', 'Utilities', 'Groceries', 'Dining', 'Transportation', 'Fuel',
  'Insurance', 'Health', 'Phone & Internet', 'Subscriptions', 'Shopping', 'Entertainment',
  'Kids', 'Personal Care', 'Gifts & Charity', 'Travel', 'Education', 'Fees',
  'Debt Payment', 'Savings', 'Investment', 'Other', 'Transfer', 'Credit Card Payment',
];

export const EXCLUDED = new Set(['transfer', 'credit card payment']);
export const EVERYDAY = new Set(['groceries', 'fuel', 'dining', 'shopping', 'bar', 'transportation', 'clothing']);

export const FREQ = {
  weekly: { days: 7, tol: 2, months: 0, perMonth: 52 / 12 },
  biweekly: { days: 14, tol: 3, months: 0, perMonth: 26 / 12 },
  monthly: { days: 30.4, tol: 5, months: 1, perMonth: 1 },
  quarterly: { days: 91, tol: 10, months: 3, perMonth: 1 / 3 },
  yearly: { days: 365, tol: 15, months: 12, perMonth: 1 / 12 },
};

export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseDate = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const today = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysBetween = (a, b) => Math.round((b - a) / 86400000);
export const addMonths = (d, n) => {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
};
export const monthKey = (d) => iso(d).slice(0, 7);

export function nthOccurrence(anchor, frequency, k) {
  const f = FREQ[frequency];
  return f.months ? addMonths(anchor, k * f.months) : addDays(anchor, k * f.days);
}

export function occurrencesBetween(anchorStr, frequency, from, to) {
  const anchor = parseDate(anchorStr);
  const out = [];
  let k = 0;
  if (anchor < from) {
    const approx = Math.floor(daysBetween(anchor, from) / FREQ[frequency].days) - 1;
    k = Math.max(0, approx);
  }
  for (let guard = 0; guard < 1000; guard++, k++) {
    const d = nthOccurrence(anchor, frequency, k);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export const flowOf = (t, acct) => (acct?.flip_sign ? -1 : 1) * Number(t.amount);

export function categoryOf(t) {
  if (t.category) return t.category;
  if (t.ruleCategory) return t.ruleCategory;
  if (t.type === 'transfer') return 'Transfer';
  if (/\btransfer\b|payment,? thank you|autopay payment - thank/i.test(t.description || '')) return 'Transfer';
  if (!t.teller_category) return 'Uncategorized';
  const c = t.teller_category;
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export const isExcluded = (t) => EXCLUDED.has(categoryOf(t).toLowerCase());

export function merchantKey(t) {
  return (t.counterparty || t.description || '')
    .toLowerCase()
    .replace(/\d{3,}/g, ' ')
    .replace(/[^a-z& ]/g, ' ')
    .replace(/\b(pos|debit|purchase|ach|recurring|payment|online|web|card|des|id|indn|co|ppd|www|com)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function classifyInterval(days) {
  for (const [name, f] of Object.entries(FREQ)) {
    if (Math.abs(days - f.days) <= f.tol) return name;
  }
  return null;
}

export function detectRecurring(txns, acctById, { now = today(), ignored = [], bills = [] } = {}) {
  const cutoff = addDays(now, -400);
  const groups = new Map();
  for (const t of txns) {
    if (t.status === 'pending' || isExcluded(t)) continue;
    if (EVERYDAY.has(categoryOf(t).toLowerCase())) continue;
    const d = parseDate(t.date);
    if (d < cutoff) continue;
    const key = merchantKey(t);
    if (!key) continue;
    const flow = flowOf(t, acctById[t.account_id]);
    if (!flow) continue;
    const gk = `${key}|${flow < 0 ? 'out' : 'in'}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({ d, flow, t });
  }

  const ignoredSet = new Set(ignored);
  const billKeys = new Set(bills.map((b) => b.match_key).filter(Boolean));
  const results = [];

  for (const [gk, items] of groups) {
    if (ignoredSet.has(gk) || billKeys.has(gk)) continue;
    const byDay = new Map();
    for (const it of items) {
      const k = iso(it.d);
      if (!byDay.has(k)) byDay.set(k, { d: it.d, flow: 0, t: it.t });
      byDay.get(k).flow += it.flow;
    }
    const pts = [...byDay.values()].sort((a, b) => a.d - b.d);
    if (pts.length < 2) continue;

    const intervals = [];
    for (let i = 1; i < pts.length; i++) intervals.push(daysBetween(pts[i - 1].d, pts[i].d));
    const freq = classifyInterval(median(intervals));
    if (!freq) continue;
    const minCount = FREQ[freq].days >= 85 ? 2 : 3;
    if (pts.length < minCount) continue;

    const tol = FREQ[freq].tol;
    const goodIntervals = intervals.filter((x) => Math.abs(x - FREQ[freq].days) <= tol).length;
    if (goodIntervals / intervals.length < 0.6) continue;

    const amounts = pts.map((p) => Math.abs(p.flow));
    const med = median(amounts);
    const steady = amounts.filter((a) => Math.abs(a - med) <= Math.max(1, med * 0.2)).length;
    if (steady / amounts.length < 0.6) continue;

    const last = pts[pts.length - 1];
    let next = nthOccurrence(last.d, freq, 1);
    if (daysBetween(next, now) > FREQ[freq].days * 1.5) continue;
    let k = 1;
    while (next < now && k < 50) next = nthOccurrence(last.d, freq, ++k);

    const recent = pts.slice(-3).map((p) => Math.abs(p.flow));
    results.push({
      key: gk,
      name: last.t.counterparty || last.t.description || gk.split('|')[0],
      kind: last.flow < 0 ? 'expense' : 'income',
      amount: Math.round((recent.reduce((s, x) => s + x, 0) / recent.length) * 100) / 100,
      frequency: freq,
      lastDate: iso(last.d),
      nextDue: iso(next),
      count: pts.length,
    });
  }
  return results.sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}

export function upcomingEvents(bills, detected, { from = today(), days = 60, includeDetected = true } = {}) {
  const to = addDays(from, days);
  const events = [];
  for (const b of bills) {
    if (!b.active) continue;
    for (const d of occurrencesBetween(b.next_due, b.frequency, from, to)) {
      events.push({ date: iso(d), name: b.name, amount: b.kind === 'income' ? +b.amount : -b.amount, source: 'bill', ref: b });
    }
  }
  if (includeDetected) {
    for (const r of detected) {
      for (const d of occurrencesBetween(r.nextDue, r.frequency, from, to)) {
        events.push({ date: iso(d), name: r.name, amount: r.kind === 'income' ? r.amount : -r.amount, source: 'auto', ref: r });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
}

export function everydaySpendPerDay(txns, acctById, recurringMonthlyOut, { now = today() } = {}) {
  const from = addDays(now, -90);
  let spend = 0;
  for (const t of txns) {
    const d = parseDate(t.date);
    if (d < from || d >= now || isExcluded(t)) continue;
    const f = flowOf(t, acctById[t.account_id]);
    if (f < 0) spend += -f;
  }
  const recurringOver90 = recurringMonthlyOut * (90 / 30.4);
  return Math.max(0, (spend - recurringOver90) / 90);
}

export function projectBalance(startBalance, events, { from = today(), days = 60, dailySpend = 0 } = {}) {
  const byDay = new Map();
  for (const e of events) byDay.set(e.date, (byDay.get(e.date) || 0) + e.amount);
  const points = [];
  let bal = startBalance;
  let low = { date: iso(from), balance: startBalance };
  for (let i = 0; i <= days; i++) {
    const d = iso(addDays(from, i));
    if (i > 0) bal -= dailySpend;
    bal += byDay.get(d) || 0;
    points.push({ date: d, balance: Math.round(bal * 100) / 100 });
    if (bal < low.balance) low = { date: d, balance: bal };
  }
  return { points, low };
}

export function monthTotals(txns, acctById, month) {
  let income = 0;
  let spend = 0;
  const byCat = {};
  for (const t of txns) {
    if (t.date.slice(0, 7) !== month || isExcluded(t)) continue;
    const f = flowOf(t, acctById[t.account_id]);
    if (f > 0) income += f;
    else {
      spend += -f;
      const c = categoryOf(t);
      byCat[c] = (byCat[c] || 0) + -f;
    }
  }
  return { income, spend, net: income - spend, byCat };
}

export function monthlyPayment(principal, annualRatePct, years) {
  const n = years * 12;
  const r = annualRatePct / 1200;
  if (principal <= 0) return 0;
  if (!r) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

export function goalMath(g, saved, avgMonthlyNet, now = today()) {
  const price = +g.homePrice || 0;
  const downPct = +g.downPct || 0;
  const closingPct = +g.closingPct || 0;
  const needed = price * (downPct + closingPct) / 100 + (+g.cushion || 0);
  const remaining = Math.max(0, needed - saved);
  const pct = needed ? Math.min(1, saved / needed) : 0;

  let monthsLeft = null;
  let perMonthNeeded = null;
  if (g.targetDate) {
    const target = parseDate(g.targetDate);
    monthsLeft = Math.max(0, (target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth());
    perMonthNeeded = monthsLeft > 0 ? remaining / monthsLeft : remaining;
  }

  let eta = null;
  if (remaining === 0) eta = iso(now);
  else if (avgMonthlyNet > 0) eta = iso(addMonths(now, Math.ceil(remaining / avgMonthlyNet)));

  const rate = +g.rate || 0;
  const years = +g.termYears || 30;
  const loan = price * (1 - downPct / 100);
  const pi = monthlyPayment(loan, rate, years);
  const escrow = price * (+g.taxInsPct || 0) / 100 / 12;
  const housing = pi + escrow;
  const gross = +g.grossMonthlyIncome || 0;
  const debts = +g.monthlyDebts || 0;
  const frontDti = gross ? housing / gross : null;
  const backDti = gross ? (housing + debts) / gross : null;

  let maxPrice = null;
  if (gross) {
    const factor = monthlyPayment(1, rate, years);
    const perDollar = factor * (1 - downPct / 100) + (+g.taxInsPct || 0) / 1200;
    const budget = 0.36 * gross - debts;
    maxPrice = perDollar > 0 && budget > 0 ? budget / perDollar : 0;
  }

  return { needed, remaining, pct, monthsLeft, perMonthNeeded, eta, loan, pi, escrow, housing, frontDti, backDti, maxPrice };
}
