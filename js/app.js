import * as F from './finance.js';

const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

const S = {
  tab: 'overview',
  accounts: [],
  txns: [],
  bills: [],
  enrollments: [],
  settings: {},
  detected: [],
  charts: [],
  filter: { month: F.monthKey(F.today()), account: '', category: '', q: '' },
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cents = true) => {
  const v = Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return `${Number(n) < 0 ? '−' : ''}$${v}`;
};
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const niceDate = (s) => F.parseDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const monthLabel = (m) => F.parseDate(`${m}-01`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4500);
}

async function run(promise, okMsg) {
  const { error } = await promise;
  if (error) {
    toast(error.message, true);
    return false;
  }
  if (okMsg) toast(okMsg);
  return true;
}

async function fetchAll(table, build) {
  let rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table)).range(from, from + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function loadAll() {
  const since = F.iso(F.addDays(F.today(), -430));
  const [accounts, txns, bills, enrollments, settings] = await Promise.all([
    fetchAll('accounts', (q) => q.select('*').order('institution').order('name')),
    fetchAll('transactions', (q) => q.select('*').gte('date', since).order('date', { ascending: false }).order('id')),
    fetchAll('bills', (q) => q.select('*').order('next_due')),
    fetchAll('enrollments', (q) => q.select('id,institution,status,last_synced,last_error,created_at')),
    sb.from('settings').select('data').eq('id', 1).maybeSingle(),
  ]);
  S.accounts = accounts;
  S.bills = bills;
  S.enrollments = enrollments;
  S.settings = settings.data?.data || {};
  const rules = S.settings.rules || {};
  for (const t of txns) {
    const r = rules[F.merchantKey(t)];
    if (r) t.ruleCategory = r;
  }
  S.txns = txns;
  derive();
}

function derive() {
  S.acctById = Object.fromEntries(S.accounts.map((a) => [a.id, a]));
  S.detected = F.detectRecurring(S.txns, S.acctById, { ignored: S.settings.ignoredRecurring || [], bills: S.bills });
}

const acctName = (a) => (a ? a.nickname || `${a.institution ? a.institution + ' ' : ''}${a.name}${a.last_four ? ' ••' + a.last_four : ''}` : 'Unknown');
const balanceOf = (a) => {
  if (a.type === 'credit' || a.type === 'loan') return Math.abs(Number(a.balance_ledger ?? 0));
  return Number(a.balance_available ?? a.balance_ledger ?? 0);
};
const visible = () => S.accounts.filter((a) => !a.hidden);
const sumBal = (pred) => visible().filter(pred).reduce((s, a) => s + balanceOf(a), 0);

function totals() {
  const cash = sumBal((a) => a.type === 'depository');
  const credit = sumBal((a) => a.type === 'credit');
  const invest = sumBal((a) => a.type === 'investment' || a.type === 'retirement');
  const loans = sumBal((a) => a.type === 'loan');
  const goalSaved = S.accounts.filter((a) => a.include_in_goal && a.type !== 'credit' && a.type !== 'loan').reduce((s, a) => s + balanceOf(a), 0);
  return { cash, credit, invest, loans, net: cash + invest - credit - loans, goalSaved };
}

function lastMonths(n) {
  const out = [];
  const t = F.today();
  for (let i = n - 1; i >= 0; i--) out.push(F.monthKey(new Date(t.getFullYear(), t.getMonth() - i, 1)));
  return out;
}

function avgNetLastFullMonths(n = 3) {
  const months = lastMonths(n + 1).slice(0, n);
  const nets = months.map((m) => F.monthTotals(S.txns, S.acctById, m).net);
  return nets.reduce((s, x) => s + x, 0) / n;
}

function projection(days = 60) {
  const includeDetected = S.settings.includeDetected !== false;
  const events = F.upcomingEvents(S.bills, S.detected, { days, includeDetected });
  const monthlyOut =
    S.bills.filter((b) => b.active && b.kind === 'expense').reduce((s, b) => s + b.amount * F.FREQ[b.frequency].perMonth, 0) +
    (includeDetected ? S.detected.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount * F.FREQ[r.frequency].perMonth, 0) : 0);
  const dailySpend = S.settings.includeEveryday === false ? 0 : F.everydaySpendPerDay(S.txns, S.acctById, monthlyOut);
  const start = totals().cash;
  return { events, dailySpend, ...F.projectBalance(start, events, { days, dailySpend }) };
}

function destroyCharts() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
}

function chartDefaults() {
  const Chart = window.Chart;
  Chart.defaults.font.family = css('--font-sans');
  Chart.defaults.color = css('--text-2');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.plugins.tooltip.backgroundColor = css('--tooltip-bg');
  Chart.defaults.plugins.tooltip.titleColor = css('--tooltip-fg');
  Chart.defaults.plugins.tooltip.bodyColor = css('--tooltip-fg');
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.callbacks.label = (ctx) => `${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${money(ctx.parsed.y ?? ctx.parsed.x, false)}`;
}

function makeChart(id, config) {
  const el = document.getElementById(id);
  if (!el || !window.Chart) return;
  S.charts.push(new window.Chart(el, config));
}

const moneyTick = (v) => money(v, false);

function render() {
  destroyCharts();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  const views = { overview, transactions, bills, goal, accounts };
  $('#view').innerHTML = views[S.tab]();
  renderSyncStatus();
  if (window.Chart) chartDefaults();
  const after = { overview: overviewCharts, bills: billsCharts };
  after[S.tab]?.();
}

function renderSyncStatus() {
  const times = S.enrollments.map((e) => e.last_synced).filter(Boolean).sort();
  const last = times[times.length - 1];
  if (!last) return ($('#sync-status').textContent = S.enrollments.length ? 'Waiting for first sync' : '');
  const mins = Math.round((Date.now() - new Date(last)) / 60000);
  const ago = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  $('#sync-status').textContent = `Bank data synced ${ago} ago`;
}

function problemBanner() {
  const bad = S.enrollments.filter((e) => e.status !== 'active');
  if (!bad.length) return '';
  return `<div class="banner warn"><strong>Needs attention:</strong> ${bad.map((e) => esc(e.institution || e.id)).join(', ')} ${bad.length > 1 ? 'are' : 'is'} disconnected or erroring. Go to <a href="#" data-action="tab" data-tab="accounts">Accounts</a> and click Reconnect.</div>`;
}

function overview() {
  const t = totals();
  const g = S.settings.goal || {};
  const gm = F.goalMath(g, t.goalSaved, avgNetLastFullMonths());
  const month = F.monthKey(F.today());
  const mt = F.monthTotals(S.txns, S.acctById, month);
  const p = projection(60);
  const soon = p.events.filter((e) => e.date <= F.iso(F.addDays(F.today(), 14)));
  const empty = !S.accounts.length;

  return `
    ${problemBanner()}
    ${empty ? `<div class="banner">No accounts yet. Head to <a href="#" data-action="tab" data-tab="accounts">Accounts</a> to connect Chase and SoFi and add your retirement accounts.</div>` : ''}
    <div class="tiles">
      <div class="tile"><div class="tile-label">Cash in bank</div><div class="tile-value">${money(t.cash, false)}</div><div class="tile-sub">Checking + savings</div></div>
      <div class="tile"><div class="tile-label">Credit cards owed</div><div class="tile-value">${money(t.credit, false)}</div><div class="tile-sub">Current balances</div></div>
      <div class="tile"><div class="tile-label">Retirement &amp; investments</div><div class="tile-value">${money(t.invest, false)}</div><div class="tile-sub">TIAA, American Funds</div></div>
      <div class="tile"><div class="tile-label">Home fund</div><div class="tile-value">${g.homePrice ? `${Math.round(gm.pct * 100)}%` : '—'}</div><div class="tile-sub">${g.homePrice ? `${money(t.goalSaved, false)} of ${money(gm.needed, false)}` : '<a href="#" data-action="tab" data-tab="goal">Set your goal</a>'}</div></div>
    </div>

    <div class="grid two">
      <div class="card">
        <div class="card-head"><h2>${F.parseDate(month + '-01').toLocaleDateString('en-US', { month: 'long' })} so far</h2></div>
        <div class="mini-stats">
          <div><span class="muted small">Money in</span><strong>${money(mt.income, false)}</strong></div>
          <div><span class="muted small">Money out</span><strong>${money(mt.spend, false)}</strong></div>
          <div><span class="muted small">Net</span><strong class="${mt.net < 0 ? 'neg' : 'pos'}">${money(mt.net, false)}</strong></div>
        </div>
        <h3 class="sub">Spending by category</h3>
        <div class="chart-box short"><canvas id="cat-chart" aria-label="Spending by category this month"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Income vs spending</h2><span class="muted small">Last 6 months · transfers excluded</span></div>
        <div class="chart-box"><canvas id="trend-chart" aria-label="Income versus spending by month"></canvas></div>
      </div>
    </div>

    <div class="grid two">
      <div class="card">
        <div class="card-head"><h2>Projected cash</h2><span class="muted small">Next 60 days</span></div>
        <div class="chart-box"><canvas id="proj-chart" aria-label="Projected cash balance"></canvas></div>
        <p class="small ${p.low.balance < 0 ? 'neg' : 'muted'}">${p.low.balance < 0 ? '⚠ ' : ''}Lowest point: <strong>${money(p.low.balance, false)}</strong> on ${niceDate(p.low.date)}. Includes known bills, paychecks${p.dailySpend ? ` and about ${money(p.dailySpend, false)}/day of everyday spending` : ''}.</p>
      </div>
      <div class="card">
        <div class="card-head"><h2>Due in the next 14 days</h2><a href="#" class="small" data-action="tab" data-tab="bills">All bills</a></div>
        ${soon.length ? `<ul class="list">${soon.map((e) => `
          <li><span class="date">${niceDate(e.date)}</span><span class="grow">${esc(e.name)}${e.source === 'auto' ? ' <span class="pill">auto</span>' : ''}</span><span class="amt ${e.amount < 0 ? '' : 'pos'}">${money(e.amount)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing due in the next two weeks.</p>'}
      </div>
    </div>`;
}

function overviewCharts() {
  const months = lastMonths(6);
  const data = months.map((m) => F.monthTotals(S.txns, S.acctById, m));
  makeChart('trend-chart', {
    type: 'bar',
    data: {
      labels: months.map(monthLabel),
      datasets: [
        { label: 'Income', data: data.map((d) => d.income), backgroundColor: css('--series-1'), borderRadius: 4, maxBarThickness: 22 },
        { label: 'Spending', data: data.map((d) => d.spend), backgroundColor: css('--series-2'), borderRadius: 4, maxBarThickness: 22 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: moneyTick, maxTicksLimit: 5 }, border: { display: false } } },
    },
  });

  const mt = F.monthTotals(S.txns, S.acctById, F.monthKey(F.today()));
  let cats = Object.entries(mt.byCat).sort((a, b) => b[1] - a[1]);
  if (cats.length > 8) cats = [...cats.slice(0, 7), ['Everything else', cats.slice(7).reduce((s, c) => s + c[1], 0)]];
  makeChart('cat-chart', {
    type: 'bar',
    data: { labels: cats.map((c) => c[0]), datasets: [{ data: cats.map((c) => c[1]), backgroundColor: css('--series-1'), borderRadius: 4, maxBarThickness: 16 }] },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => money(ctx.parsed.x, false) } } },
      scales: { x: { ticks: { callback: moneyTick, maxTicksLimit: 4 }, border: { display: false } }, y: { grid: { display: false } } },
    },
  });

  projChart('proj-chart', projection(60).points);
}

function projChart(id, points) {
  makeChart(id, {
    type: 'line',
    data: {
      labels: points.map((p) => niceDate(p.date)),
      datasets: [{ label: 'Projected cash', data: points.map((p) => p.balance), borderColor: css('--series-1'), borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.15 }],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
        y: { ticks: { callback: moneyTick, maxTicksLimit: 5 }, border: { display: false }, grid: { color: (c) => (c.tick.value === 0 ? css('--text-3') : css('--grid')) } },
      },
    },
  });
}

function categoryOptions(selected) {
  const all = new Set([...F.CATEGORIES, ...S.txns.map((t) => F.categoryOf(t))]);
  return [...all].sort((a, b) => a.localeCompare(b)).map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function filteredTxns() {
  const f = S.filter;
  const q = f.q.toLowerCase();
  return S.txns.filter((t) =>
    (!f.month || t.date.startsWith(f.month)) &&
    (!f.account || t.account_id === f.account) &&
    (!f.category || F.categoryOf(t) === f.category) &&
    (!q || `${t.description} ${t.counterparty || ''} ${t.note || ''}`.toLowerCase().includes(q))
  );
}

function transactions() {
  const rows = filteredTxns();
  const months = [...new Set(S.txns.map((t) => t.date.slice(0, 7)))];
  if (!months.includes(S.filter.month) && S.filter.month) months.unshift(S.filter.month);
  let inn = 0, out = 0;
  for (const t of rows) {
    if (F.isExcluded(t)) continue;
    const f = F.flowOf(t, S.acctById[t.account_id]);
    if (f > 0) inn += f; else out -= f;
  }
  const shown = rows.slice(0, 400);

  return `
    <div class="card">
      <div class="filters">
        <select data-filter="month"><option value="">All months</option>${months.sort().reverse().map((m) => `<option value="${m}" ${m === S.filter.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
        <select data-filter="account"><option value="">All accounts</option>${S.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === S.filter.account ? 'selected' : ''}>${esc(acctName(a))}</option>`).join('')}</select>
        <select data-filter="category"><option value="">All categories</option>${categoryOptions(S.filter.category)}</select>
        <input type="search" data-filter="q" placeholder="Search" value="${esc(S.filter.q)}">
      </div>
      <p class="small muted">${rows.length} transactions · in ${money(inn)} · out ${money(out)} · transfers and card payments not counted</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Date</th><th>Description</th><th class="hide-sm">Account</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>
            ${shown.map((t) => {
              const f = F.flowOf(t, S.acctById[t.account_id]);
              const cat = F.categoryOf(t);
              return `<tr class="${t.status === 'pending' ? 'pending' : ''}">
                <td class="nowrap">${niceDate(t.date)}</td>
                <td>${esc(t.counterparty || t.description)}${t.counterparty && t.counterparty !== t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}${t.status === 'pending' ? ' <span class="pill">pending</span>' : ''}</td>
                <td class="hide-sm small muted">${esc(acctName(S.acctById[t.account_id]))}</td>
                <td><select class="cat-select" data-change="category" data-id="${esc(t.id)}">${categoryOptions(cat)}</select></td>
                <td class="num ${f > 0 ? 'pos' : ''}">${money(f)}</td>
                <td>${t.is_manual ? `<button class="icon-btn" title="Delete" data-action="del-txn" data-id="${esc(t.id)}">✕</button>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${rows.length > shown.length ? `<p class="small muted">Showing the first ${shown.length}. Narrow the filters to see more.</p>` : ''}
    </div>

    <details class="card">
      <summary><h2>Add a cash or manual transaction</h2></summary>
      <form id="txn-form" class="form-grid">
        <label>Date<input type="date" name="date" value="${F.iso(F.today())}" required></label>
        <label>Description<input name="description" required></label>
        <label>Amount<input type="number" name="amount" step="0.01" min="0" required></label>
        <label>Direction<select name="dir"><option value="out">Money out</option><option value="in">Money in</option></select></label>
        <label>Account<select name="account_id">${S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(acctName(a))}</option>`).join('')}</select></label>
        <label>Category<select name="category">${categoryOptions('Other')}</select></label>
        <div class="form-actions"><button class="btn primary">Add transaction</button></div>
      </form>
    </details>`;
}

const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

function nextDueOf(b) {
  const occ = F.occurrencesBetween(b.next_due, b.frequency, F.today(), F.addDays(F.today(), 400));
  return occ[0] ? F.iso(occ[0]) : b.next_due;
}

function bills() {
  const p = projection(60);
  const monthlyOut = S.bills.filter((b) => b.active && b.kind === 'expense').reduce((s, b) => s + b.amount * F.FREQ[b.frequency].perMonth, 0);
  const monthlyIn = S.bills.filter((b) => b.active && b.kind === 'income').reduce((s, b) => s + b.amount * F.FREQ[b.frequency].perMonth, 0);
  const running = totals().cash;
  const byDate = new Map();
  for (const pt of p.points) byDate.set(pt.date, pt.balance);

  return `
    <div class="grid two">
      <div class="card">
        <div class="card-head"><h2>Upcoming 60 days</h2></div>
        <div class="chart-box short"><canvas id="bills-proj" aria-label="Projected cash balance"></canvas></div>
        <ul class="list">${p.events.map((e) => `
          <li><span class="date">${niceDate(e.date)}</span><span class="grow">${esc(e.name)}${e.source === 'auto' ? ' <span class="pill">auto</span>' : ''}</span><span class="amt ${e.amount > 0 ? 'pos' : ''}">${money(e.amount)}</span><span class="bal muted small">${money(byDate.get(e.date) ?? running, false)}</span></li>`).join('') || '<li class="muted">Nothing scheduled. Add bills below or confirm suggestions.</li>'}</ul>
        <p class="small muted">Right column is projected cash after that day.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>Suggested from your history</h2></div>
        <p class="small muted">Charges and deposits that repeat on a schedule. Confirm the real ones so they're locked in, or ignore them.</p>
        ${S.detected.length ? `<ul class="list">${S.detected.map((r, i) => `
          <li><span class="grow"><strong>${esc(r.name)}</strong><div class="muted small">${FREQ_LABEL[r.frequency]} · ${r.kind === 'income' ? 'income' : 'expense'} · seen ${r.count}× · next ~${niceDate(r.nextDue)}</div></span>
          <span class="amt ${r.kind === 'income' ? 'pos' : ''}">${money(r.amount)}</span>
          <span class="actions"><button class="btn small" data-action="confirm-rec" data-i="${i}">Add</button><button class="btn ghost small" data-action="ignore-rec" data-i="${i}">Ignore</button></span></li>`).join('')}</ul>` : '<p class="muted">Nothing new detected. This fills in after a few months of synced history.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Bills, subscriptions &amp; paychecks</h2><span class="muted small">About ${money(monthlyOut, false)}/mo out · ${money(monthlyIn, false)}/mo in</span></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Type</th><th>How often</th><th>Next</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${S.bills.map((b) => `
            <tr class="${b.active ? '' : 'pending'}">
              <td>${esc(b.name)}</td>
              <td>${b.kind === 'income' ? 'Income' : 'Bill'}</td>
              <td>${FREQ_LABEL[b.frequency]}</td>
              <td class="nowrap">${niceDate(nextDueOf(b))}</td>
              <td class="num ${b.kind === 'income' ? 'pos' : ''}">${money(b.amount)}</td>
              <td class="nowrap"><button class="icon-btn" data-action="toggle-bill" data-id="${b.id}">${b.active ? 'Pause' : 'Resume'}</button><button class="icon-btn" title="Delete" data-action="del-bill" data-id="${b.id}">✕</button></td>
            </tr>`).join('') || '<tr><td colspan="6" class="muted">No bills yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <form id="bill-form" class="form-grid">
        <label>Name<input name="name" placeholder="Rent, Netflix, Paycheck…" required></label>
        <label>Amount<input type="number" name="amount" step="0.01" min="0" required></label>
        <label>Type<select name="kind"><option value="expense">Bill / subscription</option><option value="income">Income</option></select></label>
        <label>How often<select name="frequency">${Object.entries(FREQ_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'monthly' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Next due<input type="date" name="next_due" value="${F.iso(F.today())}" required></label>
        <div class="form-actions"><button class="btn primary">Add</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Projection settings</h2>
      <label class="check"><input type="checkbox" data-change="setting" data-key="includeDetected" ${S.settings.includeDetected !== false ? 'checked' : ''}> Include unconfirmed suggestions in projections</label>
      <label class="check"><input type="checkbox" data-change="setting" data-key="includeEveryday" ${S.settings.includeEveryday !== false ? 'checked' : ''}> Subtract everyday spending (groceries, gas, etc.) based on the last 90 days</label>
    </div>`;
}

function billsCharts() {
  projChart('bills-proj', projection(60).points);
}

function goal() {
  const g = S.settings.goal || {};
  const t = totals();
  const avgNet = avgNetLastFullMonths();
  const gm = F.goalMath(g, t.goalSaved, avgNet);
  const counted = S.accounts.filter((a) => a.include_in_goal);
  const field = (name, label, attrs = '', hint = '') =>
    `<label>${label}<input name="${name}" value="${esc(g[name] ?? '')}" ${attrs}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const dtiStatus = (x, limit) => (x == null ? '' : x <= limit ? '<span class="status good">✓ within guideline</span>' : '<span class="status bad">▲ above guideline</span>');

  return `
    <div class="grid two">
      <div class="card">
        <h2>Your target</h2>
        <form id="goal-form" class="form-grid">
          ${field('homePrice', 'Home price', 'type="number" step="1000" min="0" placeholder="350000"')}
          ${field('downPct', 'Down payment %', 'type="number" step="0.5" min="0" max="100" placeholder="10"', '3–20% is typical')}
          ${field('closingPct', 'Closing costs %', 'type="number" step="0.5" min="0" placeholder="3"', 'Often 2–5% of price')}
          ${field('cushion', 'Moving / emergency cushion $', 'type="number" step="100" min="0" placeholder="5000"')}
          ${field('targetDate', 'Target buy date', 'type="date"')}
          ${field('rate', 'Mortgage rate %', 'type="number" step="0.125" min="0" placeholder="6.5"', 'Check a current rate quote')}
          ${field('termYears', 'Loan term (years)', 'type="number" step="5" min="5" placeholder="30"')}
          ${field('taxInsPct', 'Taxes + insurance % / yr', 'type="number" step="0.1" min="0" placeholder="2"', 'Indiana property tax + homeowners insurance, roughly')}
          ${field('grossMonthlyIncome', 'Gross monthly income (both)', 'type="number" step="100" min="0"', 'Before taxes')}
          ${field('monthlyDebts', 'Other monthly debt payments', 'type="number" step="10" min="0"', 'Car, student loans, card minimums')}
          <div class="form-actions"><button class="btn primary">Save goal</button></div>
        </form>
      </div>

      <div class="card">
        <h2>Progress</h2>
        ${!g.homePrice ? '<p class="muted">Enter a home price to see your numbers.</p>' : `
        <div class="progress" role="progressbar" aria-valuenow="${Math.round(gm.pct * 100)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${(gm.pct * 100).toFixed(1)}%"></div></div>
        <p class="big">${money(t.goalSaved, false)} <span class="muted">of ${money(gm.needed, false)}</span></p>
        <dl class="kv">
          <dt>Still needed</dt><dd>${money(gm.remaining, false)}</dd>
          ${gm.monthsLeft != null ? `<dt>Needed per month to hit ${niceDate(g.targetDate)} ${F.parseDate(g.targetDate).getFullYear()}</dt><dd>${money(gm.perMonthNeeded, false)}</dd>` : ''}
          <dt>Your average net saving (last 3 months)</dt><dd class="${avgNet < 0 ? 'neg' : ''}">${money(avgNet, false)}/mo</dd>
          <dt>At that pace you're ready</dt><dd>${gm.eta ? F.parseDate(gm.eta).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Not on track yet'}</dd>
        </dl>
        <p class="small muted">Counting: ${counted.length ? counted.map((a) => esc(acctName(a))).join(', ') : 'no accounts yet'}. Change this on the <a href="#" data-action="tab" data-tab="accounts">Accounts</a> tab.</p>

        <h3 class="sub">Estimated monthly payment</h3>
        <dl class="kv">
          <dt>Loan amount</dt><dd>${money(gm.loan, false)}</dd>
          <dt>Principal + interest</dt><dd>${money(gm.pi, false)}</dd>
          <dt>Taxes + insurance</dt><dd>${money(gm.escrow, false)}</dd>
          <dt><strong>Total housing</strong></dt><dd><strong>${money(gm.housing, false)}</strong></dd>
        </dl>
        ${gm.frontDti != null ? `
        <h3 class="sub">Debt-to-income</h3>
        <dl class="kv">
          <dt>Housing ÷ income</dt><dd>${pct(gm.frontDti)} ${dtiStatus(gm.frontDti, 0.28)}</dd>
          <dt>All debts ÷ income</dt><dd>${pct(gm.backDti)} ${dtiStatus(gm.backDti, 0.36)}</dd>
          <dt>Price that keeps all debts at 36%</dt><dd>${money(gm.maxPrice, false)}</dd>
        </dl>
        <p class="small muted">28% / 36% is a common rule of thumb; lenders may approve higher. A real pre-approval is the final word.</p>` : ''}`}
      </div>
    </div>`;
}

function accounts() {
  const linked = S.accounts.filter((a) => !a.is_manual);
  const manual = S.accounts.filter((a) => a.is_manual);
  const typeLabel = { depository: 'Bank', credit: 'Credit card', investment: 'Investment', retirement: 'Retirement', loan: 'Loan', other: 'Other' };
  const ago = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

  const acctRow = (a) => `
    <tr class="${a.hidden ? 'pending' : ''}">
      <td><input class="inline" data-change="acct-field" data-field="nickname" data-id="${esc(a.id)}" value="${esc(a.nickname || '')}" placeholder="${esc(`${a.institution || ''} ${a.name}${a.last_four ? ' ••' + a.last_four : ''}`.trim())}"></td>
      <td>${typeLabel[a.type] || esc(a.type || '')}${a.subtype ? `<div class="muted small">${esc(a.subtype.replace(/_/g, ' '))}</div>` : ''}</td>
      <td class="num">${a.is_manual ? `<input class="inline num" type="number" step="0.01" data-change="acct-balance" data-id="${esc(a.id)}" value="${esc(a.balance_ledger ?? '')}">` : money(balanceOf(a))}</td>
      <td class="center"><input type="checkbox" data-change="acct-flag" data-field="include_in_goal" data-id="${esc(a.id)}" ${a.include_in_goal ? 'checked' : ''} ${a.type === 'credit' || a.type === 'loan' ? 'disabled' : ''}></td>
      <td class="center"><input type="checkbox" data-change="acct-flag" data-field="hidden" data-id="${esc(a.id)}" ${a.hidden ? 'checked' : ''}></td>
      <td class="center">${a.is_manual ? '' : `<input type="checkbox" data-change="acct-flag" data-field="flip_sign" data-id="${esc(a.id)}" ${a.flip_sign ? 'checked' : ''}>`}</td>
      <td>${a.is_manual ? `<button class="icon-btn" title="Delete" data-action="del-acct" data-id="${esc(a.id)}">✕</button>` : ''}</td>
    </tr>`;
  const head = '<thead><tr><th>Name</th><th>Type</th><th class="num">Balance</th><th class="center">Home fund</th><th class="center">Hide</th><th class="center">Flip ±</th><th></th></tr></thead>';

  return `
    ${problemBanner()}
    <div class="card">
      <div class="card-head"><h2>Connected banks</h2>
        <div class="actions">
          <button class="btn primary" data-action="connect">Connect a bank</button>
          <a class="btn ghost" href="${esc(cfg.syncWorkflowUrl)}" target="_blank" rel="noopener">Sync now ↗</a>
        </div>
      </div>
      <p class="small muted">Your bank login happens in Teller's secure window. This app never sees your username or password. New data arrives every 3 hours, or right away when you click <em>Sync now</em> and then <em>Run workflow</em> on GitHub.</p>
      ${S.enrollments.length ? `<ul class="list">${S.enrollments.map((e) => `
        <li><span class="grow"><strong>${esc(e.institution || e.id)}</strong>
          <div class="small ${e.status === 'active' ? 'muted' : 'neg'}">${e.status === 'active' ? 'Connected' : e.status === 'disconnected' ? 'Disconnected — reconnect to keep syncing' : 'Error: ' + esc(e.last_error || '')} · last synced ${ago(e.last_synced)}</div></span>
          <span class="actions">${e.status !== 'active' ? `<button class="btn small" data-action="reconnect" data-id="${esc(e.id)}">Reconnect</button>` : ''}<button class="btn ghost small" data-action="del-enr" data-id="${esc(e.id)}">Remove</button></span></li>`).join('')}</ul>` : '<p class="muted">No banks connected yet.</p>'}
    </div>

    <div class="card">
      <h2>Accounts</h2>
      <p class="small muted"><strong>Home fund</strong>: count this balance toward your down payment. <strong>Flip ±</strong>: tick if purchases show as money in for that account.</p>
      <div class="table-wrap"><table class="table">${head}<tbody>${linked.map(acctRow).join('') || '<tr><td colspan="7" class="muted">Linked accounts appear after the first sync.</td></tr>'}</tbody></table></div>
      <h3 class="sub">Manual accounts</h3>
      <p class="small muted">For TIAA, American Funds or anything else that can't be linked. Type a new balance and click away to save.</p>
      ${manual.length ? `<div class="table-wrap"><table class="table">${head}<tbody>${manual.map(acctRow).join('')}</tbody></table></div>` : ''}
      <form id="acct-form" class="form-grid">
        <label>Institution<input name="institution" placeholder="TIAA" required></label>
        <label>Account name<input name="name" placeholder="403(b)" required></label>
        <label>Type<select name="type"><option value="retirement">Retirement</option><option value="investment">Investment</option><option value="depository">Bank</option><option value="loan">Loan</option><option value="other">Other</option></select></label>
        <label>Balance<input type="number" name="balance" step="0.01" required></label>
        <div class="form-actions"><button class="btn primary">Add manual account</button></div>
      </form>
    </div>`;
}

function openTeller(enrollmentId) {
  if (!window.TellerConnect) return toast('Teller Connect did not load. Check your ad blocker and refresh.', true);
  const tc = window.TellerConnect.setup({
    applicationId: cfg.tellerAppId,
    environment: cfg.tellerEnvironment,
    products: ['balance', 'transactions'],
    selectAccount: 'disabled',
    ...(enrollmentId ? { enrollmentId } : {}),
    onSuccess: async (enr) => {
      const row = { id: enr.enrollment.id, institution: enr.enrollment.institution.name, access_token: enr.accessToken };
      const { error } = await sb.from('enrollments').insert(row);
      if (error && error.code === '23505') {
        await run(sb.from('enrollments').update({ access_token: row.access_token, status: 'active', last_error: null }).eq('id', row.id));
      } else if (error) {
        return toast(`Could not save the connection: ${error.message}`, true);
      }
      toast(`${row.institution} connected. Click "Sync now" to pull data.`);
      await reload();
    },
  });
  tc.open();
}

async function saveSettings(patch) {
  S.settings = { ...S.settings, ...patch };
  return run(sb.from('settings').update({ data: S.settings, updated_at: new Date().toISOString() }).eq('id', 1));
}

async function reload() {
  try {
    await loadAll();
  } catch (e) {
    toast(e.message, true);
  }
  render();
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action],[data-tab]');
  if (!el) return;
  const { action, id } = el.dataset;
  if (el.dataset.tab && (!action || action === 'tab')) {
    ev.preventDefault();
    S.tab = el.dataset.tab;
    location.hash = S.tab;
    return render();
  }
  if (action === 'connect') return openTeller();
  if (action === 'reconnect') return openTeller(id);
  if (action === 'del-enr') {
    if (!confirm('Remove this bank? Its accounts and transactions will be deleted from the app (not from your bank).')) return;
    if (await run(sb.from('enrollments').delete().eq('id', id), 'Bank removed')) reload();
  }
  if (action === 'del-acct') {
    if (!confirm('Delete this manual account and its transactions?')) return;
    if (await run(sb.from('accounts').delete().eq('id', id), 'Account deleted')) reload();
  }
  if (action === 'del-txn') {
    if (await run(sb.from('transactions').delete().eq('id', id))) reload();
  }
  if (action === 'del-bill') {
    if (!confirm('Delete this bill?')) return;
    if (await run(sb.from('bills').delete().eq('id', id))) reload();
  }
  if (action === 'toggle-bill') {
    const b = S.bills.find((x) => x.id === id);
    if (await run(sb.from('bills').update({ active: !b.active }).eq('id', id))) reload();
  }
  if (action === 'confirm-rec') {
    const r = S.detected[+el.dataset.i];
    const ok = await run(sb.from('bills').insert({ name: r.name, amount: r.amount, kind: r.kind, frequency: r.frequency, next_due: r.nextDue, match_key: r.key }), `${r.name} added`);
    if (ok) reload();
  }
  if (action === 'ignore-rec') {
    const r = S.detected[+el.dataset.i];
    await saveSettings({ ignoredRecurring: [...(S.settings.ignoredRecurring || []), r.key] });
    derive();
    render();
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  const { change, id } = el.dataset;
  if (el.dataset.filter) {
    S.filter[el.dataset.filter] = el.value;
    return render();
  }
  if (change === 'category') {
    const t = S.txns.find((x) => x.id === id);
    const value = el.value;
    if (!(await run(sb.from('transactions').update({ category: value }).eq('id', id)))) return;
    t.category = value;
    const key = F.merchantKey(t);
    if (key && confirm(`Always use "${value}" for "${t.counterparty || t.description}"?`)) {
      await saveSettings({ rules: { ...(S.settings.rules || {}), [key]: value } });
      for (const x of S.txns) if (F.merchantKey(x) === key) x.ruleCategory = value;
    }
    derive();
    render();
  }
  if (change === 'acct-flag') {
    const ok = await run(sb.from('accounts').update({ [el.dataset.field]: el.checked }).eq('id', id));
    if (ok) {
      S.acctById[id][el.dataset.field] = el.checked;
      derive();
      render();
    }
  }
  if (change === 'acct-field') {
    const ok = await run(sb.from('accounts').update({ [el.dataset.field]: el.value.trim() || null }).eq('id', id), 'Saved');
    if (ok) S.acctById[id][el.dataset.field] = el.value.trim() || null;
  }
  if (change === 'acct-balance') {
    const v = Number(el.value);
    const ok = await run(sb.from('accounts').update({ balance_ledger: v, balance_available: v, updated_at: new Date().toISOString() }).eq('id', id), 'Balance updated');
    if (ok) {
      S.acctById[id].balance_ledger = v;
      S.acctById[id].balance_available = v;
    }
  }
  if (change === 'setting') {
    await saveSettings({ [el.dataset.key]: el.checked });
    derive();
    render();
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.dataset.filter === 'q') {
    clearTimeout(S.qTimer);
    S.qTimer = setTimeout(() => {
      S.filter.q = ev.target.value;
      render();
      const box = $('[data-filter="q"]');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 300);
  }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  if (form.id === 'login-form') return;
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(form));

  if (form.id === 'goal-form') {
    if (await saveSettings({ goal: d })) {
      toast('Goal saved');
      render();
    }
  }
  if (form.id === 'bill-form') {
    if (await run(sb.from('bills').insert({ name: d.name, amount: +d.amount, kind: d.kind, frequency: d.frequency, next_due: d.next_due }), 'Added')) reload();
  }
  if (form.id === 'txn-form') {
    const a = S.acctById[d.account_id];
    if (!a) return toast('Add an account first', true);
    const flow = (d.dir === 'in' ? 1 : -1) * Number(d.amount);
    const row = { account_id: d.account_id, date: d.date, description: d.description, amount: a.flip_sign ? -flow : flow, category: d.category, is_manual: true, status: 'posted' };
    if (await run(sb.from('transactions').insert(row), 'Transaction added')) reload();
  }
  if (form.id === 'acct-form') {
    const bal = Number(d.balance);
    const row = { institution: d.institution, name: d.name, type: d.type, balance_ledger: bal, balance_available: bal, is_manual: true };
    if (await run(sb.from('accounts').insert(row), 'Account added')) reload();
  }
});

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(ev.target));
  $('#login-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: d.email, password: d.password });
  if (error) $('#login-error').textContent = error.message;
});

$('#signout-btn').addEventListener('click', () => sb.auth.signOut());
$('#refresh-btn').addEventListener('click', reload);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1);
  if (started && t !== S.tab && ['overview', 'transactions', 'bills', 'goal', 'accounts'].includes(t)) {
    S.tab = t;
    render();
  }
});

let started = false;
sb.auth.onAuthStateChange((_event, session) => {
  $('#login').hidden = !!session;
  $('#app').hidden = !session;
  if (session && !started) {
    started = true;
    const fromHash = location.hash.slice(1);
    if (['overview', 'transactions', 'bills', 'goal', 'accounts'].includes(fromHash)) S.tab = fromHash;
    setTimeout(async () => {
      try {
        const { data: member } = await sb.from('members').select('user_id').eq('user_id', session.user.id).maybeSingle();
        if (!member) {
          $('#view').innerHTML = `<div class="banner warn">You're signed in as ${esc(session.user.email)}, but this login hasn't been added to the household yet. Run the "add members" step from the setup guide in Supabase.</div>`;
          return;
        }
      } catch {}
      reload();
    }, 0);
  }
  if (!session) {
    started = false;
    destroyCharts();
    $('#view').innerHTML = '';
  }
});
