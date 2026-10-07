import { createClient } from 'npm:@supabase/supabase-js@2';

const PLAID_ENV = Deno.env.get('PLAID_ENV') ?? 'production';
const PLAID_BASE = PLAID_ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com';
const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID') ?? '';
const PLAID_SECRET = Deno.env.get('PLAID_SECRET') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

function serviceKey(): string {
  const custom = Deno.env.get('SUPABASE_SECRET_KEY');
  if (custom) return custom;
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (typeof first === 'string') return first;
    } catch { /* fall through */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class PlaidError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function plaid(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${PLAID_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new PlaidError(data.error_code ?? 'PLAID_ERROR', data.error_message ?? `Plaid ${res.status}`);
  return data;
}

const RETIREMENT = /401|403|457|ira|roth|pension|retirement|thrift|keogh|sep|simple|tsp|profit sharing/i;

function mapAccount(a: any, itemId: string, institution: string) {
  const type = a.type === 'investment' && RETIREMENT.test(a.subtype ?? '') ? 'retirement' : a.type;
  return {
    id: a.account_id,
    item_id: itemId,
    institution,
    name: a.official_name || a.name,
    type,
    subtype: a.subtype,
    last_four: a.mask,
    balance_ledger: a.balances?.current,
    balance_available: a.balances?.available,
    is_manual: false,
    updated_at: new Date().toISOString(),
  };
}

function mapCategory(pfc: any): string | null {
  if (!pfc?.primary) return null;
  const p = pfc.primary;
  const d = pfc.detailed ?? '';
  if (p === 'INCOME') return 'Income';
  if (p === 'TRANSFER_IN' || p === 'TRANSFER_OUT') return 'Transfer';
  if (p === 'LOAN_PAYMENTS') return d.includes('CREDIT_CARD') ? 'Credit Card Payment' : 'Debt Payment';
  if (p === 'BANK_FEES') return 'Fees';
  if (p === 'ENTERTAINMENT') return 'Entertainment';
  if (p === 'FOOD_AND_DRINK') return d.includes('GROCERIES') ? 'Groceries' : 'Dining';
  if (p === 'GENERAL_MERCHANDISE') return 'Shopping';
  if (p === 'HOME_IMPROVEMENT') return 'Housing';
  if (p === 'MEDICAL') return 'Health';
  if (p === 'PERSONAL_CARE') return 'Personal Care';
  if (p === 'GENERAL_SERVICES') return d.includes('INSURANCE') ? 'Insurance' : d.includes('CHILDCARE') ? 'Kids' : d.includes('EDUCATION') ? 'Education' : 'Other';
  if (p === 'GOVERNMENT_AND_NON_PROFIT') return d.includes('DONATIONS') ? 'Gifts & Charity' : 'Other';
  if (p === 'TRANSPORTATION') return d.includes('GAS') ? 'Fuel' : 'Transportation';
  if (p === 'TRAVEL') return 'Travel';
  if (p === 'RENT_AND_UTILITIES') {
    if (d.includes('RENT')) return 'Housing';
    if (d.includes('TELEPHONE') || d.includes('INTERNET')) return 'Phone & Internet';
    return 'Utilities';
  }
  return 'Other';
}

function mapTxn(t: any) {
  return {
    id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    description: t.original_description || t.name,
    amount: -Number(t.amount),
    type: t.payment_channel,
    status: t.pending ? 'pending' : 'posted',
    bank_category: mapCategory(t.personal_finance_category),
    counterparty: t.merchant_name || t.counterparties?.[0]?.name || null,
    is_manual: false,
  };
}

const SKIP_TXN_CODES = new Set(['PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_READY', 'INVALID_PRODUCT', 'ADDITIONAL_CONSENT_REQUIRED', 'NO_ACCOUNTS']);
const RELINK_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'USER_PERMISSION_REVOKED', 'ITEM_NOT_FOUND']);

async function must<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

async function syncItem(item: any) {
  try {
    const acc = await plaid('/accounts/get', { access_token: item.access_token });
    const accounts = acc.accounts.map((a: any) => mapAccount(a, item.id, item.institution));
    if (accounts.length) await must(admin.from('accounts').upsert(accounts, { onConflict: 'id' }));

    let cursor = item.cursor ?? undefined;
    let count = 0;
    try {
      for (let page = 0; page < 40; page++) {
        const r = await plaid('/transactions/sync', { access_token: item.access_token, cursor, count: 500 });

        const rows = [...r.added, ...r.modified].map(mapTxn);
        const pendingIds = r.added.map((t: any) => t.pending_transaction_id).filter(Boolean);
        if (pendingIds.length) {
          const prior = await must(admin.from('transactions').select('id,category,note').in('id', pendingIds));
          const byId = new Map((prior as any[]).map((p) => [p.id, p]));
          for (const t of r.added) {
            const p = byId.get(t.pending_transaction_id);
            const row = rows.find((x) => x.id === t.transaction_id) as any;
            if (p && row) {
              if (p.category) row.category = p.category;
              if (p.note) row.note = p.note;
            }
          }
        }
        for (let i = 0; i < rows.length; i += 500) {
          await must(admin.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'id' }));
        }
        const removed = r.removed.map((x: any) => x.transaction_id);
        if (removed.length) await must(admin.from('transactions').delete().in('id', removed));

        count += rows.length;
        cursor = r.next_cursor;
        await must(admin.from('items').update({ cursor }).eq('id', item.id));
        if (!r.has_more) break;
      }
    } catch (e) {
      if (!(e instanceof PlaidError && SKIP_TXN_CODES.has(e.code))) throw e;
    }

    await must(admin.from('items').update({ status: 'active', last_synced: new Date().toISOString(), last_error: null }).eq('id', item.id));
    return { item: item.institution, accounts: accounts.length, transactions: count };
  } catch (e) {
    const code = e instanceof PlaidError ? e.code : '';
    await admin.from('items').update({
      status: RELINK_CODES.has(code) ? 'disconnected' : 'error',
      last_error: `${code ? code + ': ' : ''}${(e as Error).message}`.slice(0, 300),
    }).eq('id', item.id);
    return { item: item.institution, error: code || (e as Error).message };
  }
}

async function getItem(id: string) {
  return must(admin.from('items').select('*').eq('id', id).single()) as Promise<any>;
}

async function authorize(req: Request): Promise<{ userId: string | null; cron: boolean }> {
  const cronHeader = req.headers.get('x-cron-secret');
  if (CRON_SECRET && cronHeader && cronHeader === CRON_SECRET) return { userId: null, cron: true };

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new Error('Not signed in');
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw new Error('Not signed in');
  const { data: member } = await admin.from('members').select('user_id').eq('user_id', data.user.id).maybeSingle();
  if (!member) throw new Error('This login is not part of the household');
  return { userId: data.user.id, cron: false };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let who;
  try {
    who = await authorize(req);
  } catch (e) {
    return json({ error: (e as Error).message }, 401);
  }

  if (!PLAID_CLIENT_ID || !PLAID_SECRET) return json({ error: 'PLAID_CLIENT_ID / PLAID_SECRET are not set in Edge Function secrets' }, 500);

  const body = await req.json().catch(() => ({}));
  const action = body.action;

  try {
    if (action === 'sync') {
      const items = body.item_id
        ? [await getItem(body.item_id)]
        : ((await must(admin.from('items').select('*'))) as any[]);
      const results = [];
      for (const item of items) results.push(await syncItem(item));
      return json({ results });
    }

    if (who.cron) return json({ error: 'Scheduled calls may only sync' }, 403);

    if (action === 'link_token') {
      const base = {
        client_name: 'Home Fund',
        user: { client_user_id: who.userId },
        country_codes: ['US'],
        language: 'en',
      };
      let payload: Record<string, unknown>;
      if (body.item_id) {
        const item = await getItem(body.item_id);
        payload = { ...base, access_token: item.access_token };
      } else if (body.mode === 'investment') {
        payload = { ...base, products: ['investments'] };
      } else {
        payload = { ...base, products: ['transactions'], transactions: { days_requested: 730 } };
      }
      const r = await plaid('/link/token/create', payload);
      return json({ link_token: r.link_token });
    }

    if (action === 'exchange') {
      const r = await plaid('/item/public_token/exchange', { public_token: body.public_token });
      const item = {
        id: r.item_id,
        access_token: r.access_token,
        institution: body.institution || 'Bank',
        status: 'active',
        last_error: null,
      };
      await must(admin.from('items').upsert(item, { onConflict: 'id' }));
      const result = await syncItem(await getItem(item.id));
      return json({ ok: true, result });
    }

    if (action === 'relinked') {
      await must(admin.from('items').update({ status: 'active', last_error: null }).eq('id', body.item_id));
      const result = await syncItem(await getItem(body.item_id));
      return json({ ok: true, result });
    }

    if (action === 'remove') {
      const item = await getItem(body.item_id);
      await plaid('/item/remove', { access_token: item.access_token }).catch(() => null);
      await must(admin.from('items').delete().eq('id', item.id));
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    const code = e instanceof PlaidError ? e.code : undefined;
    return json({ error: (e as Error).message, code }, 400);
  }
});
