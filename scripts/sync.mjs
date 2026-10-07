import https from 'node:https';

const {
  TELLER_CERT,
  TELLER_KEY,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  FULL_HISTORY,
} = process.env;

for (const [name, value] of Object.entries({ TELLER_CERT, TELLER_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) {
    console.error(`Missing GitHub secret: ${name}`);
    process.exit(1);
  }
}

const agent = new https.Agent({ cert: TELLER_CERT, key: TELLER_KEY, keepAlive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tellerOnce(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.teller.io',
        path,
        method: 'GET',
        agent,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${token}:`).toString('base64'),
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let data;
          try { data = JSON.parse(body); } catch { data = body; }
          if (res.statusCode >= 400) {
            const err = new Error(`Teller ${res.statusCode} on ${path}`);
            err.status = res.statusCode;
            err.code = data?.error?.code || '';
            err.detail = data?.error?.message || '';
            reject(err);
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Teller request timed out')));
    req.end();
  });
}

async function teller(path, token) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tellerOnce(path, token);
    } catch (err) {
      if (err.status === 429 && attempt < 3) {
        await sleep(15000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function db(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const upsert = async (table, rows) => {
  for (let i = 0; i < rows.length; i += 500) {
    await db(`${table}?on_conflict=id`, {
      method: 'POST',
      body: rows.slice(i, i + 500),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
};

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function syncEnrollment(enr) {
  const token = enr.access_token;
  const accounts = await teller('/accounts', token);
  let txnCount = 0;

  for (const a of accounts) {
    if (a.status && a.status !== 'open') continue;

    let bal = {};
    try {
      bal = await teller(`/accounts/${a.id}/balances`, token);
    } catch (err) {
      console.warn(`  balance failed for ${a.name}: ${err.message}`);
    }

    await upsert('accounts', [{
      id: a.id,
      enrollment_id: enr.id,
      institution: a.institution?.name || enr.institution,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      last_four: a.last_four,
      balance_ledger: bal.ledger != null ? Number(bal.ledger) : null,
      balance_available: bal.available != null ? Number(bal.available) : null,
      is_manual: false,
      updated_at: new Date().toISOString(),
    }]);

    const firstSync = !enr.last_synced || FULL_HISTORY === 'true';
    const query = firstSync ? '' : `?start_date=${isoDaysAgo(60)}`;
    const txns = await teller(`/accounts/${a.id}/transactions${query}`, token);

    await db(`transactions?account_id=eq.${encodeURIComponent(a.id)}&status=eq.pending&is_manual=eq.false`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });

    await upsert('transactions', txns.map((t) => ({
      id: t.id,
      account_id: a.id,
      date: t.date,
      description: t.description,
      amount: Number(t.amount),
      type: t.type,
      status: t.status,
      teller_category: t.details?.category || null,
      counterparty: t.details?.counterparty?.name || null,
      is_manual: false,
    })));
    txnCount += txns.length;
    console.log(`  ${a.name} (${a.type}): ${txns.length} transactions`);
  }
  return txnCount;
}

const enrollments = await db('enrollments?select=id,institution,access_token,last_synced');
if (!enrollments.length) {
  console.log('No banks connected yet. Connect one from the Accounts tab in the app.');
  process.exit(0);
}

let failures = 0;
for (const enr of enrollments) {
  console.log(`Syncing ${enr.institution || enr.id}`);
  try {
    const n = await syncEnrollment(enr);
    await db(`enrollments?id=eq.${encodeURIComponent(enr.id)}`, {
      method: 'PATCH',
      body: { status: 'active', last_synced: new Date().toISOString(), last_error: null },
      prefer: 'return=minimal',
    });
    console.log(`  done (${n} transactions checked)`);
  } catch (err) {
    failures++;
    const disconnected = err.status === 404 || String(err.code).startsWith('enrollment.disconnected');
    console.error(`  FAILED: ${err.message} ${err.code} ${err.detail}`);
    await db(`enrollments?id=eq.${encodeURIComponent(enr.id)}`, {
      method: 'PATCH',
      body: {
        status: disconnected ? 'disconnected' : 'error',
        last_error: `${err.code || err.message}`.slice(0, 300),
      },
      prefer: 'return=minimal',
    }).catch(() => {});
  }
}

if (failures === enrollments.length) process.exit(1);
