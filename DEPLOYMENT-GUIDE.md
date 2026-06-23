# Abise Auto Parts — Setup & Deployment Guide

This is a **separate app** from any other tracker you have. It needs its **own GitHub repo** and its **own, brand-new Supabase project**. Do not reuse the database or keys from another app, or the two will mix data.

There are three things to do, in order:

1. Create a new Supabase project (the cloud database).
2. Paste its keys into `config.js`.
3. Put the files on GitHub Pages (the live website / installable app).

---

## 1) Create a NEW Supabase project

1. Go to https://supabase.com and sign in.
2. Click **New project**. Give it a name like `abise-auto-parts`. Choose a region near you, set a database password (save it somewhere), and create it.
3. Wait ~2 minutes for it to finish setting up.
4. In the left menu open **SQL Editor → New query**.
5. Open the file `database-setup.sql` from this folder, copy **everything** in it, paste into the query box, and click **Run**. You should see "Success".
6. In the left menu open **Project Settings → API**. You'll need two values from here in the next step:
   - **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
   - **anon public** key (a long string under "Project API keys")

> Email confirmation: by default Supabase may ask new accounts to confirm their email. If you'd rather skip that for the two of you, go to **Authentication → Providers → Email** and turn **Confirm email** off. Then each person can create an account and sign in immediately.

---

## 2) Paste your keys into config.js

Open `config.js` and replace the two placeholders with the values from Supabase:

```js
window.ABISE_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-public-key"
};
```

Save the file. (The anon key is safe to ship in a web app — your data is protected by the row-level security rules the SQL script set up, so only signed-in accounts can read or write.)

---

## 3) Put it on GitHub Pages

1. Create a **new repository** on GitHub (e.g. `abise-auto-parts`). Keep it **public** (Pages is free for public repos).
2. Upload **all** the files from this folder into the repo:
   `index.html, app.js, config.js, styles.css, manifest.json, sw.js, icon-192.png, icon-512.png` (the `.sql` and `.md` files can be uploaded too — they're harmless and handy to keep).
3. In the repo go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**. Pick branch `main` and folder `/ (root)`. Save.
5. Wait ~1 minute. GitHub shows a link like `https://yourname.github.io/abise-auto-parts/`. That's the live app.

---

## 4) First run — create the two accounts

1. Open the live link on a phone.
2. Tap **Create a new account**, enter the owner's email + a password (6+ characters), and sign in.
3. Do the same on your phone with your own email. Both accounts see the **same shared shop data**, live.
4. **Install it like an app:**
   - iPhone (Safari): Share → **Add to Home Screen**.
   - Android (Chrome): menu **⋮** → **Install app** / **Add to Home screen**.

---

## How updates work

The app uses a network-first service worker. Whenever you change a file and re-upload it to GitHub, anyone who opens the app while online gets the new version automatically (it refreshes itself). To force a clean refresh after a big change, bump `VERSION` in `sw.js` (e.g. `abise-v1` → `abise-v2`).

---

## What the app tracks (quick reference)

- **Parts** — inventory with category + your own item name, cost & selling price, stock count. Selling deducts stock; restock adds it. Low-stock flags at or below the number you set in Settings (default 3).
- **Repairs** — job cards with plate, customer, work, date received, date dispatched, labor price. Labor counts as income only when you mark the job **Paid**. Customer-supplied parts are never taken from your shelf.
- **Two separate books in Reports** — Parts (sold − part cost − parts expenses) and Maintenance (labor − repair expenses), each with its own profit, plus a combined total.
- **Household** spending and **loan repayments** are drawn from parts cash and shown separately, so they don't distort business profit.
- **Customers & vehicles**, **Suppliers**, **Loans**, and a **Financial audit** (exactly what each book counts, month by month) live in the side menu.

Everything is saved instantly on the phone (works offline) and synced to the cloud the moment you're back online.
