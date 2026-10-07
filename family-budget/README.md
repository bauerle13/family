# Home Fund — family budget & home-buying tracker

A private budget app for two people. It tracks income and spending, shows live bank balances, predicts upcoming bills and paychecks, and measures progress toward a down payment. It costs $0 to run.

| Piece | What it does | Cost |
|---|---|---|
| **GitHub Pages** | Hosts the website | Free |
| **Supabase** | Logins and the database (Row Level Security keeps it to your household) | Free tier |
| **Teller** | Connects to Chase and SoFi (read-only balances and transactions) | Free developer tier, up to 100 live connections |
| **GitHub Actions** | Pulls fresh bank data every 3 hours | Free for public repos |

**Your bank username and password are never stored anywhere.** You log in to your bank inside Teller's secure pop-up. Supabase only keeps the read-only access token Teller hands back, and that token is useless without your private Teller certificate. The certificate lives only in GitHub's encrypted secrets.

Total setup time is about 45 minutes. Do the parts in order.

---

## Part 1 — Create your GitHub account and repository

1. Go to **github.com** and click **Sign up**. Pick a username (it becomes part of your web address, e.g. `bauerle-family.github.io`). Verify your email.
2. Turn on two-factor authentication: profile picture → **Settings** → **Password and authentication** → **Enable two-factor authentication**. Do this — this account will hold the keys to your bank sync.
3. Create the repository from **VS Code** (it uploads every file, including the hidden `.github` folder that the GitHub website upload tends to skip):
   1. Unzip `family-budget.zip` somewhere permanent, like `Documents/family-budget`.
   2. In VS Code: **File → Open Folder…** → pick that folder.
   3. Click the **Source Control** icon on the left (the branching icon) → **Initialize Repository**.
   4. Type a message like `First version` → **Commit** (say Yes if it asks to stage all changes).
   5. Click **Publish Branch** → sign in to GitHub when asked → name it `family-budget` → choose **Publish to GitHub public repository**. Free GitHub Pages requires a public repo; see "Is a public repo safe?" below.
4. Turn on the website: repo → **Settings** → **Pages** → under **Build and deployment**, Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)** → **Save**. After a minute or two the page shows your address: `https://YOUR-USERNAME.github.io/family-budget/`.

---

## Part 2 — Set up Supabase (database + logins)

1. Go to **supabase.com** → **Start your project** → **Continue with GitHub** (uses the account you just made).
2. **New project**:
   - Name: `family-budget`
   - Database password: click **Generate a password** and save it in your password manager
   - Region: **East US (Ohio)** or the closest one
   - Click **Create new project** and wait about 2 minutes.
3. **Create the tables:** left menu → **SQL Editor** → **New query**. Open `supabase/schema.sql` from this project, copy all of it, paste it in, and click **Run**. You should see "Success. No rows returned."
4. **Create both logins:** left menu → **Authentication** → **Users** → **Add user** → **Create new user**. Enter an email and a strong password, keep **Auto Confirm User** checked, and click **Create user**. Repeat for the second adult.
5. **Add both people to the household.** Back in **SQL Editor** → **New query**, paste this, change the two emails and names, and click **Run**:

   ```sql
   insert into public.members (user_id, display_name)
   select id, 'Justin' from auth.users where email = 'you@example.com';

   insert into public.members (user_id, display_name)
   select id, 'Partner' from auth.users where email = 'partner@example.com';
   ```

6. **Block strangers from signing up:** **Authentication** → **Sign In / Providers** → **Email** → turn **off** "Allow new users to sign up" → **Save**. (Exact labels may move around in Supabase's dashboard over time; the setting is in the email provider options.)
7. **Set the site address:** **Authentication** → **URL Configuration** → **Site URL** = `https://YOUR-USERNAME.github.io/family-budget/` → **Save**.
8. **Copy your keys:** gear icon **Project Settings** → **API Keys**. You need three values. Keep this tab open:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`). It's also under **Project Settings → Data API**.
   - **Publishable key** (starts with `sb_publishable_`). This one goes in the website.
   - **Secret key** (starts with `sb_secret_`; click **Reveal**). This one goes **only** into GitHub secrets in Part 4. Never paste it into any file.

   > On the **Legacy API keys** tab, `anon` works in place of the publishable key and `service_role` works in place of the secret key.

---

## Part 3 — Set up Teller (bank connection)

1. Go to **teller.io** → **Sign up**. Verify your email and turn on two-factor if offered.
2. In the Teller dashboard, open your **Application** and copy the **Application ID** (starts with `app_`).
3. Go to **Certificates** → create a new certificate. Teller downloads a zip containing `certificate.pem` and `private_key.pem`.
   - **Keep `private_key.pem` secret.** Don't email it, and don't put it in the project folder. (The project's `.gitignore` blocks `.pem` files just in case.)
   - Store the zip somewhere safe, like your password manager's secure notes or an encrypted folder.
4. You'll use the **development** environment. It connects to your real banks and is free for up to 100 connections, which is far more than you need.

---

## Part 4 — Give GitHub the secrets for the sync job

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Create these four, spelled exactly like this:

| Name | Value |
|---|---|
| `TELLER_CERT` | Open `certificate.pem` in a text editor and paste **everything**, including the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines |
| `TELLER_KEY` | Same for `private_key.pem`: everything, including the BEGIN/END lines |
| `SUPABASE_URL` | Your Project URL from Part 2 |
| `SUPABASE_SECRET_KEY` | Your Supabase **secret** key from Part 2 |

GitHub encrypts these. Not even you can view them again after saving; you can only replace them.

---

## Part 5 — Point the website at your accounts

Edit `config.js` in VS Code and fill in the four placeholders:

```js
window.APP_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseKey: 'sb_publishable_xxxxxxxx',
  tellerAppId: 'app_xxxxxxxx',
  tellerEnvironment: 'development',
  syncWorkflowUrl: 'https://github.com/YOUR-USERNAME/family-budget/actions/workflows/sync.yml',
};
```

Commit and **Sync Changes** (push) in VS Code. GitHub Pages republishes in about a minute.

---

## Part 6 — First run

1. Open `https://YOUR-USERNAME.github.io/family-budget/` and sign in.
2. Go to **Accounts** → **Connect a bank** → search **Chase** → log in → approve. Do the same for **SoFi**.
   - If SoFi isn't in Teller's list, add it as a **manual account** for now and update its balance by hand. Chase will still sync automatically.
3. Click **Sync now** (opens GitHub) → **Run workflow** → tick **Re-pull full transaction history** → **Run workflow**. Wait for the green check (about a minute), then click **Reload** in the app.
4. On the **Accounts** tab:
   - Tick **Home fund** next to the SoFi savings account (and anything else you're saving for the house in).
   - Add **TIAA** and **American Funds** as manual accounts with type **Retirement**. Update their balances whenever you check them, monthly is plenty.
   - Look at a Chase credit card purchase on the Transactions tab. If purchases show as green "money in," tick **Flip ±** for that card.
5. Fill in the **Home Goal** tab.
6. After the history loads, open **Bills**. Under **Suggested from your history**, click **Add** for real bills and paychecks and **Ignore** for the rest. Add anything it missed (rent, insurance, annual subscriptions) with the form.
7. On **Transactions**, fix any wrong categories. When it asks "Always use … for …?", say OK, and future transactions from that merchant get the same category.

From then on, bank data refreshes every 3 hours by itself.

---

## Good to know

**Is a public repo safe?** Yes, as long as no secrets are in it. The repo holds only website code. All financial data lives in Supabase behind your logins, and Row Level Security blocks everyone who isn't in the `members` table. The publishable key in `config.js` is designed to be public. The Teller certificate and Supabase secret key exist only in GitHub's encrypted secrets.

**Things that can pause on the free tiers:**
- *GitHub* turns off scheduled workflows in public repos after 60 days with no commits. You'll get an email. Go to the **Actions** tab and click **Enable workflow**, or make any small commit.
- *Supabase* pauses free projects after a week with no activity. The 3-hour sync keeps it active. If it ever pauses, click **Restore** in the Supabase dashboard; your data is kept.

**A bank says "Disconnected."** Banks occasionally require you to log in again (password change, new security check). The app shows a yellow banner; go to **Accounts** → **Reconnect**.

**How bill predictions work.** The app looks through the last ~13 months for charges or deposits from the same merchant at a steady rhythm (weekly, every 2 weeks, monthly, quarterly, yearly) and similar amounts. Groceries, gas, dining and shopping are deliberately left out. Those count as "everyday spending," which the projection subtracts as a daily average from the last 90 days instead.

**What "Projected cash" includes.** It starts from today's checking + savings balances, then adds expected paychecks and subtracts bills and everyday spending day by day. Credit card payments aren't projected separately, because card purchases already show up in your spending.

**The mortgage numbers are estimates.** The debt-to-income check uses the common 28% / 36% rule of thumb. A lender's pre-approval is what actually counts.

## Troubleshooting

| Problem | Fix |
|---|---|
| Sign-in works but you see "hasn't been added to the household" | Run the Part 2, step 5 SQL with that exact email |
| Sync job fails with `Missing GitHub secret` | Check the four secret names in Part 4. They must match exactly |
| Sync job fails with a certificate or 401 error | Re-paste `TELLER_CERT` / `TELLER_KEY` including the BEGIN/END lines. Make sure the certificate belongs to the same Teller app as `tellerAppId` |
| "Connect a bank" does nothing | An ad or tracker blocker may be blocking `cdn.teller.io`. Allow it for your site |
| Balances look old | **Accounts** → **Sync now** → **Run workflow**, then **Reload** |

## Files

```
index.html                  page shell
styles.css                  look and feel (light + dark mode)
config.js                   your public settings (Part 5)
js/app.js                   screens and buttons
js/finance.js               bill detection, projections, home-goal math
scripts/sync.mjs            bank → database sync (runs on GitHub Actions)
.github/workflows/sync.yml  sync schedule (every 3 hours + manual button)
supabase/schema.sql         database tables and security rules
```
