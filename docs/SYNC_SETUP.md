# Phase 1 setup — Cloudflare Access + KV (multi-device sync)

The code is deployed but cloud sync is OFF until you complete two dashboard steps. Until then, the app behaves exactly like before: localStorage only, no login required. The header chip will show **"● Local only"**.

After both steps below, the chip turns green: **"● your@email.com · Saved · just now"**.

---

## 1. Create the KV namespace (~1 min)

Cloud sync needs a Cloudflare KV namespace to store each user's data.

### Option A — Wrangler CLI (recommended, faster)

```sh
cd /Users/alexanderhaack/Claude/commander-forge

# Authenticate (if you haven't already)
brew install cloudflare-wrangler   # skip if already installed
wrangler login                      # opens browser

# Create the KV namespace
wrangler kv namespace create CMDR_FORGE_STATE
```

The command prints something like:

```
🌀  Creating namespace with title "commander-forge-CMDR_FORGE_STATE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "STATE", id = "abcd1234ef5678ghij9012kl3456mnop" }
```

In `wrangler.toml`, **uncomment** the three `[[kv_namespaces]]` lines and paste the **id** value:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "abcd1234ef5678ghij9012kl3456mnop"   # ← paste the real id here
```

> The block is commented out by default because Cloudflare rejects the deploy when the placeholder is present. Uncommenting only after you have a real id is what flips sync from "Local only" to "Cloud" — that's exactly the toggle.

Commit and push — Cloudflare auto-deploys.

### Option B — Cloudflare dashboard (no CLI needed)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **KV** (left sidebar)
2. Click **Create a namespace** → name it `commander-forge-CMDR_FORGE_STATE` → **Add**
3. Copy the namespace ID from the resulting page
4. Edit `wrangler.toml` locally, **uncomment** the `[[kv_namespaces]]` block and paste the id, commit and push

---

## 2. Set up Cloudflare Access (~5 min)

This is the auth layer — friends click a "login with Google / email PIN" button, Cloudflare verifies them, and the Worker receives their email.

### Enable Zero Trust (one-time, free)

1. <https://one.dash.cloudflare.com> — sign in with the same Cloudflare account that hosts the Worker
2. The first time you visit, accept the free "Zero Trust" team plan (no credit card, ≤50 users)
3. Pick a team name (e.g. `commander-forge`) — this becomes part of the login URL friends see

### Configure identity providers

1. **Settings** → **Authentication** → **Login methods** → **Add new**
2. **One-time PIN** — already enabled by default; leave it. (Sends a 6-digit code to any email address; works for friends without Google accounts.)
3. **Add new → Google** — sign in with Google → confirm. (Now friends with Google accounts get a one-click "Sign in with Google" button.)

### Create the application

1. **Access** → **Applications** → **Add an application** → **Self-hosted**
2. Application settings:
   - **Application name:** `Commander Forge`
   - **Session duration:** `24 hours` (so friends don't log in every visit)
3. **Application domain:**
   - **Subdomain:** `commander-forge`
   - **Domain:** `rafaelteuteburg.workers.dev`
   - Leave path empty (protect entire app)
4. **Identity providers:** check both **One-time PIN** and **Google** → Next

### Add the access policy (who can log in)

1. **Policy name:** `Friends`
2. **Action:** **Allow**
3. **Rule — Include:**
   - Selector: **Emails**
   - Value: list of allowed emails, one per line. Example:
     ```
     rafaelteuteburg@gmail.com
     friend1@gmail.com
     friend2@example.com
     ```
4. Click **Next** → **Add application**

> ⚠ **Important:** include **your own email** in the list. Otherwise you'll be locked out of your own app.

---

## 3. Verify

1. Open <https://commander-forge.rafaelteuteburg.workers.dev> in an **incognito window**
2. You should now see a Cloudflare login page (Google + email PIN options)
3. Sign in with one of the allowed emails
4. After auth, the app loads. The header chip should turn green: **"● your@email.com · Saved · just now"**
5. Make a change (e.g. paste a Gemini key in Settings). Wait ~5 seconds. The chip should briefly show "Saving…" then update.
6. Close the tab, reopen the URL in a different browser, sign in with the same email — your settings should reappear automatically.

---

## What happens when it's NOT configured

The app is designed to degrade gracefully. Each setup step adds capability:

| KV configured? | Access configured? | Behavior |
|---|---|---|
| ❌ | ❌ | localStorage only (chip: "● Local only"). Current behavior. |
| ❌ | ✅ | Friends sign in, but data isn't synced. Chip: "● email · Cloud sync isn't set up on this deployment yet." |
| ✅ | ❌ | Worker accepts /api/state but no email is set → effectively LS only. Chip: "● Local only". |
| ✅ | ✅ | Full multi-device sync. Chip: "● email · Saved · …" |

So you can do step 1 and step 2 in either order, in separate sessions, and the app keeps working throughout.

---

## Troubleshooting

### "Local only" stays gray after Access setup

- Confirm in DevTools (Network tab) that `/api/me` returns `{"authenticated": true, "email": "..."}`
- If it returns `{"authenticated": false}`, the JWT/email headers aren't reaching the Worker. Possible causes:
  - You visited the URL directly without going through the Access login first — clear cookies and revisit
  - The Access application's domain doesn't match the URL — check exact spelling in Zero Trust → Access → Applications

### "Cloud sync isn't set up on this deployment yet"

The KV binding isn't live. Either:
- `wrangler.toml` still has `id = "REPLACE_WITH_KV_NAMESPACE_ID"` — paste the real id and push again
- The Cloudflare deploy hasn't picked up the new binding — wait ~30 seconds and reload

### "Conflict — reload to load latest data from cloud"

Two devices wrote at the same time. Refresh the tab; the most recent save wins.

### KV write quota exceeded

Free tier is 1 000 writes/day per account. The app debounces to one write per ~5 seconds of activity. For ≤5 friends doing normal usage, you won't hit this. If you do, the chip stays red until the next day's quota refresh, but the app keeps working in LS-only mode.
