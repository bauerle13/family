# Home Fund — family budget & home-buying tracker

A private budget app for two people. It tracks income and spending, shows live bank balances, predicts upcoming bills and paychecks, and measures progress toward a down payment. It costs $0 to run.

| Piece | What it does | Cost |
|---|---|---|
| **GitHub Pages** | Hosts the website | Free |
| **Supabase** | Logins, the database, and a small server function that talks to Plaid | Free tier |
| **Plaid** | Connects to Chase, SoFi, and possibly TIAA / American Funds (read-only) | Free Trial plan, up to 10 connections |

**Your bank username and password are never stored anywhere.** You log in to your bank inside Plaid's secure pop-up. Plaid gives back a read-only access token. That token, and your Plaid secret, live only inside Supabase on the server side. The website can't read them, and they're never in your GitHub repo.

**Plaid's free plan allows 10 connections in total, and removing one doesn't give it back.** One connection = one login at one bank. Chase, SoFi, TIAA and American Funds use 4, leaving 6 spare. If a bank breaks, use **Reconnect** (free); don't remove it and add it again.

Total setup time is about 45 minutes. Do the parts in order.

---

## Part 1 — Create your GitHub account and website

1. Go to **github.com** → **Sign up**. Pick a username (it becomes part of your web address, e.g. `bauerle-family.github.io`). Verify your email.
2. Turn on two-factor authentication: profile picture → **Settings** → **Password and authentication** → **Enable two-factor authentication**.
3. Publish the code from **VS Code**:
   1. Unzip `family-budget.zip` somewhere permanent, like `Documents/family-budget`.
   2. VS Code → **File → Open Folder…** → pick that folder.
   3. Click the **Source Control** icon on the left → **Initialize Repository**.
   4. Type `First version` → **Commit** (say Yes if it asks to stage all changes).
   5. Click **Publish Branch** → sign in to GitHub → name it `family-budget` → **Publish to GitHub public repository**. Free GitHub Pages requires a public repo; see "Is a public repo safe?" below.
4. Turn on the website: repo on github.com → **Settings** → **Pages** → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)** → **Save**. After a minute or two it shows your address: `https://YOUR-USERNAME.github.io/family-budget/`.

---

## Part 2 — Set up Supabase (database + logins)

1. **supabase.com** → **Start your project** → **Continue with GitHub**.
2. **New project**: name `family-budget`. Click **Generate a password** and save it in your password manager. Region **East US (Ohio)** or the closest one. Click **Create new project** and wait about 2 minutes.
3. **Create the tables:** **SQL Editor** → **New query**. Paste all of `supabase/schema.sql` → **Run**. You should see "Success. No rows returned."
4. **Create both logins:** **Authentication** → **Users** → **Add user** → **Create new user**. Enter an email and a strong password, keep **Auto Confirm User** checked. Repeat for the second adult.
5. **Add both people to the household:** **SQL Editor** → **New query**. Change the emails and names, then **Run**:

   ```sql
   insert into public.members (user_id, display_name)
   select id, 'Justin' from auth.users where email = 'you@example.com';

   insert into public.members (user_id, display_name)
   select id, 'Partner' from auth.users where email = 'partner@example.com';
   ```

6. **Block strangers from signing up:** **Authentication** → **Sign In / Providers** → **Email** → turn **off** "Allow new users to sign up" → **Save**.
7. **Site address:** **Authentication** → **URL Configuration** → **Site URL** = `https://YOUR-USERNAME.github.io/family-budget/` → **Save**.
8. **Copy two values** from **Project Settings** → **API Keys** (the Project URL is also under **Data API**):
   - **Project URL**, like `https://abcdefgh.supabase.co`
   - **Publishable key**, starting with `sb_publishable_`. If you only see Legacy keys, the `anon` key works too.

---

## Part 3 — Set up Plaid (bank connection)

1. Go to **dashboard.plaid.com/signup**. When it asks how you'll use Plaid, choose **Personal use** ("build something for fun"). Verify your email.
2. Apply for the free **Trial plan**: there's a button on the dashboard home page, or go to **dashboard.plaid.com/trial-plan**. It asks you to verify your identity, and most applications are approved automatically.
3. Turn on two-factor authentication in your Plaid account settings.
4. Go to **Developers → Keys** and copy:
   - **client_id**
   - **Production secret**. Treat it like a password. It goes only into Supabase in Part 4.

If Chase or another bank later shows a message about needing extra registration, check the Plaid dashboard for an "OAuth institutions" or registration checklist. Plaid says a few banks need an extra step even on the Trial plan.

---

## Part 4 — Install the server function in Supabase

This small function holds your Plaid secret and does the bank syncing. Everything happens in the Supabase dashboard, with nothing to install.

1. **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly **`plaid`**. Delete the sample code, paste all of `supabase/functions/plaid/index.ts`, and click **Deploy**.
3. Open the function's **Details / Settings** and turn **off** "Enforce JWT verification" (sometimes labeled "Verify JWT") → **Save**. The function checks logins itself, and this lets the 3-hour scheduler reach it.
4. **Edge Functions** → **Secrets** → add these four:

   | Name | Value |
   |---|---|
   | `PLAID_CLIENT_ID` | your Plaid client_id |
   | `PLAID_SECRET` | your Plaid **Production** secret |
   | `PLAID_ENV` | `production` |
   | `CRON_SECRET` | a long random password you make up, e.g. 40 random characters from your password manager. Save it; you need it in the next step |

5. **Turn on automatic syncing:** **SQL Editor** → **New query**. Paste `supabase/schedule.sql`, replace the two placeholders (your Project URL and the same `CRON_SECRET`), then **Run**. If it complains about an extension, go to **Database → Extensions**, enable **pg_cron** and **pg_net**, and run it again.

---

## Part 5 — Point the website at Supabase

Edit `config.js` in VS Code:

```js
window.APP_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseKey: 'sb_publishable_xxxxxxxx',
};
```

**Commit** and **Sync Changes** in VS Code. GitHub Pages republishes in about a minute.

---

## Part 6 — First run

1. Open `https://YOUR-USERNAME.github.io/family-budget/` and sign in.
2. **Accounts** → **Connect bank or card** → **Chase** → log in → approve. Repeat for **SoFi**.
3. **Connect retirement** → search **TIAA**, then **American Funds**. If either one isn't listed or won't connect, add it as a **manual account** instead (type: Retirement) and update the balance monthly.
4. Plaid needs a few minutes to fetch older history after a new connection. Wait 5–10 minutes, then click **Sync now**.
5. On **Accounts**, tick **Home fund** next to the SoFi savings account (and anything else you're saving for the house in).
6. Fill in the **Home Goal** tab.
7. Open **Bills**. Under **Suggested from your history**, click **Add** for real bills and paychecks and **Ignore** for the rest. Add anything it missed with the form.
8. On **Transactions**, fix any wrong categories. When it asks "Always use … for …?", say OK, and future transactions from that merchant get the same category.

From then on, bank data refreshes every 3 hours by itself, and **Sync now** refreshes it on demand.

---

## Good to know

**Is a public repo safe?** Yes. The repo holds only website code. All financial data lives in Supabase behind your two logins, and Row Level Security blocks anyone not in the `members` table. The publishable key in `config.js` is designed to be public. Your Plaid secret and bank access tokens exist only inside Supabase.

**Free-tier pauses.** Supabase pauses free projects after about a week with no activity. Opening the app at least once a week guarantees it stays awake. The 3-hour sync probably counts as activity too, but don't rely on it. If it ever pauses, click **Restore** in the Supabase dashboard. Nothing is lost.

**A bank says it needs you to log in again.** Banks occasionally require this after a password change or a new security check. You'll see a yellow banner; go to **Accounts** → **Reconnect**. Reconnecting does not use up one of the 10 connections.

**How bill predictions work.** The app looks through the last ~13 months for charges or deposits from the same merchant at a steady rhythm (weekly, every 2 weeks, monthly, quarterly, yearly) and similar amounts. Groceries, gas, dining and shopping are deliberately left out. Those count as "everyday spending," which the projection subtracts as a daily average from the last 90 days instead.

**What "Projected cash" includes.** It starts from today's checking + savings balances, then adds expected paychecks and subtracts bills and everyday spending day by day. Credit card payments aren't projected separately, because card purchases already show up in your spending.

**The mortgage numbers are estimates.** The debt-to-income check uses the common 28% / 36% rule of thumb. A lender's pre-approval is what actually counts.

## Troubleshooting

| Problem | Fix |
|---|---|
| Sign-in works but you see "hasn't been added to the household" | Run the Part 2, step 5 SQL with that exact email |
| "Connect" shows an error about `PLAID_CLIENT_ID` | Check the Part 4 secrets, then redeploy the function |
| "Connect" shows `INVALID_API_KEYS` | Use the **Production** secret (not Sandbox) and set `PLAID_ENV` to `production` |
| Any button says "Not signed in" or "Invalid API key" | Edge Functions → Secrets → add `SUPABASE_SECRET_KEY` with your Supabase secret key (`sb_secret_…`, under Project Settings → API Keys) |
| Nothing happens when you click Connect | An ad or tracker blocker may be blocking `cdn.plaid.com`. Allow it for your site |
| Balances never update on their own | **SQL Editor**: run `select * from cron.job_run_details order by start_time desc limit 5;` to see the scheduler's recent runs, and check the function's **Logs** tab |

## Files

```
index.html                         page shell
styles.css                         look and feel (light + dark mode)
config.js                          your public settings (Part 5)
js/app.js                          screens and buttons
js/finance.js                      bill detection, projections, home-goal math
supabase/schema.sql                database tables and security rules (Part 2)
supabase/functions/plaid/index.ts  server function that talks to Plaid (Part 4)
supabase/schedule.sql              3-hour automatic sync (Part 4)
```
