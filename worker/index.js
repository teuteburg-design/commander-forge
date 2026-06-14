// Commander Forge — Cloudflare Worker entry point.
//
// Routes:
//   GET  /api/me         → returns the authenticated user's email (or {auth:false} when
//                          Cloudflare Access isn't configured / no JWT present)
//   GET  /api/state      → loads the user's cloud-synced app state from KV
//   PUT  /api/state      → saves the user's cloud-synced app state to KV
//   GET  /api/quota      → returns today's shared-Gemini usage for the signed-in user
//   POST /api/ai/gemini  → proxy to Gemini with the host's key, enforces daily cap
//   /edhrec/*            → proxy GET to json.edhrec.com (CORS sidestep)
//   /spellbook/*         → proxy POST to backend.commanderspellbook.com (CORS sidestep)
//   /archidekt/*         → proxy any method to archidekt.com (CORS sidestep + auth header forwarding)
//   anything else        → fall through to ASSETS (static files in ./public)
//
// Auth:
//   When Cloudflare Access is configured for this Worker's hostname, every
//   request arrives with `Cf-Access-Authenticated-User-Email` and a verified
//   JWT in `Cf-Access-Jwt-Assertion`. We trust the email header (Access has
//   already verified the JWT at the edge) and use it as the KV key prefix.
//   Until Access is configured, /api/me returns {authenticated:false} and the
//   client falls back to localStorage-only behaviour — the app keeps working.
//
// The proxy routes mirror what proxy.py does for local development. They exist
// because:
//   - EDHRec / Cloudflare-fronted endpoints fingerprint browser fetches and
//     occasionally CORS-block the response.
//   - Spellbook's find-my-combos POST isn't CORS-friendly.
//   - Archidekt's API has no documented browser-CORS allowance at all.

// Path prefix → upstream base URL. Each request hitting one of these prefixes
// is forwarded server-side; the browser sees a same-origin response.
const PROXY_ROUTES = {
  "/edhrec/":        "https://json.edhrec.com",
  "/spellbook/":     "https://backend.commanderspellbook.com",
  "/archidekt/":     "https://archidekt.com",
  // Public Manabox deck-share pages. The deck JSON is embedded inside an
  // <astro-island component-export="Main"> element's props attribute — the
  // client parses it out. We just need to sidestep CORS.
  "/manabox-share/": "https://manabox.app",
  "/mtgwtf/":        "https://mtg.wtf",
};

// EDHRec / Cloudflare-fronted endpoints reject "default fetch" UAs. Pretending
// to be Chrome avoids the fingerprint-driven 403/429s.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Headers we forward FROM the client TO the upstream. Anything not in this list
// (cookies from the host's domain, Cloudflare-injected headers, etc.) is dropped.
const FORWARD_REQ_HEADERS = ["content-type", "accept", "authorization"];

// Headers we forward FROM the upstream BACK to the client. Keep tight — only
// what the browser actually needs.
const FORWARD_RES_HEADERS = ["content-type", "cache-control"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Identity + cloud-sync endpoints ─────────────────────────────────
    if (url.pathname === "/api/me") {
      return handleMe(request);
    }
    if (url.pathname === "/api/state") {
      if (request.method === "GET") return handleStateGet(request, env);
      if (request.method === "PUT") return handleStatePut(request, env);
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/api/quota" && request.method === "GET") {
      return handleQuota(request, env);
    }
    if (url.pathname === "/api/ai/gemini" && request.method === "POST") {
      return handleSharedGemini(request, env);
    }

    // ── Pre-con catalog (cached from mtg.wtf) ───────────────────────────
    if (url.pathname === "/api/precons" && request.method === "GET") {
      return handlePreconIndex(request, env, ctx);
    }
    if (url.pathname === "/api/precons/refresh" && request.method === "POST") {
      return handlePreconRefresh(request, env, ctx);
    }
    const preconMatch = url.pathname.match(/^\/api\/precons\/([^/]+)\/([^/]+)$/);
    if (preconMatch && request.method === "GET") {
      return handlePreconDeck(request, env, preconMatch[1], preconMatch[2]);
    }

    // Match against proxy routes. First-prefix-wins.
    for (const [prefix, target] of Object.entries(PROXY_ROUTES)) {
      if (url.pathname.startsWith(prefix)) {
        return handleProxy(request, prefix, target);
      }
    }

    // Everything else: static asset.
    return env.ASSETS.fetch(request);
  },

  // Cron-triggered refresh. wrangler.toml controls the schedule
  // (default: daily @ 06:00 UTC).
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshPrecons(env, { reason: "cron" }).catch(err => {
      console.error("Cron refresh failed:", err);
    }));
  },
};

// ── Pre-con cache ───────────────────────────────────────────────────────
// We mirror mtg.wtf/deck server-side so the client gets a fast same-origin
// JSON API (no third-party scraping, no per-user CORS proxy hops). The
// scheduled handler diffs the upstream index nightly and pulls any new or
// changed decks via their /download plain-text endpoint.
const KV_PRECON_INDEX  = "precons:index";          // { updated, entries: [...] }
const KV_PRECON_DECK   = (set, slug) => `precons:deck:${set}/${slug}`;
const KV_PRECON_LOCK   = "precons:lock";           // simple in-flight marker
const PRECON_MAX_PARALLEL = 4;                     // simultaneous /download fetches

async function fetchText(url, label = "") {
  const r = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,text/plain,*/*" },
  });
  if (!r.ok) throw new Error(`${label || url}: HTTP ${r.status}`);
  return await r.text();
}

// Decode HTML entities — workers don't have a DOM textarea trick, so this
// covers the handful that mtg.wtf actually emits.
function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function preconCategory(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("commander")) return "commander";
  if (t.includes("welcome")) return "welcome";
  if (t.includes("jumpstart")) return "jumpstart";
  if (t.includes("theme") || t.includes("starter") || t.includes("challenger")
      || t.includes("planeswalker deck") || t.includes("planeswalker pack")) return "theme";
  return "other";
}

// Walk the mtg.wtf /deck HTML with regex (no DOMParser in workers). We
// alternate between heading captures (set name) and list-item captures
// (individual deck entries). Pulls every /deck/<set>/<slug> link with its
// type + card count + parent set name.
function parseMtgWtfIndexHtml(html) {
  const out = [];
  let currentSet = null;
  // One regex that matches either an opening heading OR a <li>...</li> entry
  // in source order. We use the running `g` flag's lastIndex to advance.
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      // Heading — extract text only.
      const txt = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, "").trim());
      if (txt) currentSet = txt;
    } else if (m[3] && currentSet) {
      const liInner = m[3];
      const deckLink = liInner.match(/<a\b[^>]+href="\/deck\/([^"\/]+)\/([^"\/]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!deckLink) continue;
      const setCode = deckLink[1].toLowerCase();
      const slug = deckLink[2];
      const name = decodeHtmlEntities(deckLink[3].replace(/<[^>]+>/g, "").trim());
      // The tail after the anchor carries "— Commander Deck (100 cards)".
      const afterAnchor = liInner.slice(liInner.indexOf("</a>") + 4);
      const tail = decodeHtmlEntities(afterAnchor.replace(/<[^>]+>/g, "").trim().replace(/^[—–-]\s*/, ""));
      const cardMatch = tail.match(/\((\d+)\s*cards?\)/i);
      const cardCount = cardMatch ? parseInt(cardMatch[1], 10) : null;
      const type = tail.replace(/\(.*?\)/g, "").trim();
      const collector = /collector/i.test(currentSet) || /collector/i.test(name);
      out.push({
        set: setCode, slug, name, type, cardCount,
        setName: currentSet,
        collector,
        category: preconCategory(type),
      });
    }
  }
  return out;
}

// Parse the /deck/<set>/<slug>/download plain-text format:
//   // NAME: ...
//   // URL: ...
//   // DATE: 2026-06-26
//   COMMANDER: 1 Card Name
//   PARTNER: 1 Card Name
//   1 Other Card
//   ...
function parseMtgWtfDownload(text) {
  const lines = text.split(/\r?\n/);
  const meta = {};
  const commanders = [];
  const cards = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//")) {
      const m = line.match(/^\/\/\s*([A-Z]+):\s*(.+)$/);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    const cmdMatch = line.match(/^(COMMANDER|PARTNER|COMPANION)\s*:\s*(\d+)\s+(.+)$/i);
    if (cmdMatch) {
      const role = cmdMatch[1].toUpperCase();
      const cardName = cmdMatch[3].trim();
      if (role === "COMMANDER" || role === "PARTNER") commanders.push(cardName);
      // companion: ignored for the deck-builder model (no slot)
      continue;
    }
    const cardMatch = line.match(/^(\d+)\s+(.+)$/);
    if (cardMatch) {
      cards.push({ name: cardMatch[2].trim(), qty: parseInt(cardMatch[1], 10) });
    }
  }
  return {
    name:        meta.name        || "",
    url:         meta.url         || "",
    releasedAt:  meta.date        || "",
    commanders,
    partners:    commanders.length >= 2,
    cards,
  };
}

async function fetchAndParseDeck(setCode, slug) {
  const url = `https://mtg.wtf/deck/${encodeURIComponent(setCode)}/${encodeURIComponent(slug)}/download`;
  const text = await fetchText(url, `download ${setCode}/${slug}`);
  const parsed = parseMtgWtfDownload(text);
  // /download omits the set name and deck type; copy them from the index.
  return { ...parsed, set: setCode, slug };
}

async function readPreconIndex(env) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(KV_PRECON_INDEX);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Diff and refresh. Compares upstream entries to the cached index. For every
// new or changed entry (changes detected via shallow key equality on name/
// type/cardCount/setName) we re-fetch the /download text and store it.
async function refreshPrecons(env, { reason = "unknown", force = false } = {}) {
  if (!env.STATE) throw new Error("STATE KV not configured");

  // Lightweight lock to keep two refreshes from racing. KV writes are
  // strongly consistent within a region but eventual across, so this is
  // best-effort — it just avoids most accidental double-runs.
  const lockRaw = await env.STATE.get(KV_PRECON_LOCK);
  if (lockRaw && !force) {
    const since = Date.now() - parseInt(lockRaw, 10);
    if (since < 10 * 60 * 1000) return { skipped: true, reason: "lock held" };
  }
  await env.STATE.put(KV_PRECON_LOCK, String(Date.now()), { expirationTtl: 600 });

  const startedAt = Date.now();
  const indexHtml = await fetchText("https://mtg.wtf/deck", "index");
  const upstream  = parseMtgWtfIndexHtml(indexHtml);

  const current = await readPreconIndex(env);
  const seenKey = new Map();
  (current?.entries || []).forEach(e => {
    seenKey.set(`${e.set}/${e.slug}`, e);
  });

  // Find entries that are new OR whose visible metadata changed.
  const dirty = [];
  for (const u of upstream) {
    const k = `${u.set}/${u.slug}`;
    const old = seenKey.get(k);
    if (!old
        || old.name !== u.name
        || old.type !== u.type
        || old.cardCount !== u.cardCount
        || old.setName !== u.setName) {
      dirty.push(u);
    }
  }

  // Limited parallelism so we don't DOS mtg.wtf (or hit worker subrequest caps).
  let downloaded = 0;
  let failed = 0;
  for (let i = 0; i < dirty.length; i += PRECON_MAX_PARALLEL) {
    const batch = dirty.slice(i, i + PRECON_MAX_PARALLEL);
    const results = await Promise.allSettled(batch.map(async (e) => {
      const deck = await fetchAndParseDeck(e.set, e.slug);
      await env.STATE.put(KV_PRECON_DECK(e.set, e.slug), JSON.stringify({
        ...deck,
        setName: e.setName,
        type: e.type,
        cardCount: e.cardCount,
      }));
    }));
    for (const r of results) (r.status === "fulfilled" ? downloaded++ : failed++);
  }

  // Write the new index. We always store the FULL upstream listing (not a
  // diff) so the client gets a consistent snapshot.
  const indexDoc = {
    updated: Date.now(),
    upstreamCount: upstream.length,
    cachedDecks: upstream.length,
    entries: upstream,
    lastRefresh: { reason, startedAt, finishedAt: Date.now(), downloaded, failed, dirty: dirty.length },
  };
  await env.STATE.put(KV_PRECON_INDEX, JSON.stringify(indexDoc));
  await env.STATE.delete(KV_PRECON_LOCK);
  return indexDoc.lastRefresh;
}

async function handlePreconIndex(request, env, ctx) {
  if (!env.STATE) return jsonResponse({ error: "precon cache not configured" }, 503);
  let doc = await readPreconIndex(env);
  // Cold start: kick off a refresh in the background and return a 202 with
  // any cached data we have (which will be null on the very first call).
  if (!doc) {
    ctx.waitUntil(refreshPrecons(env, { reason: "cold-start" }).catch(() => {}));
    return jsonResponse({
      entries: [],
      updated: 0,
      status: "refreshing",
    }, 202);
  }
  return jsonResponse(doc);
}

async function handlePreconDeck(_request, env, setCode, slug) {
  if (!env.STATE) return jsonResponse({ error: "precon cache not configured" }, 503);
  const raw = await env.STATE.get(KV_PRECON_DECK(setCode, slug));
  if (raw) {
    try { return jsonResponse(JSON.parse(raw)); } catch {}
  }
  // Cache miss — fetch on demand (don't wait for the next cron).
  try {
    const deck = await fetchAndParseDeck(setCode, slug);
    await env.STATE.put(KV_PRECON_DECK(setCode, slug), JSON.stringify(deck));
    return jsonResponse(deck);
  } catch (e) {
    return jsonResponse({ error: e?.message || "fetch failed" }, 502);
  }
}

async function handlePreconRefresh(request, env, ctx) {
  if (!env.STATE) return jsonResponse({ error: "precon cache not configured" }, 503);
  // Anyone signed in can trigger a refresh. Anonymous callers get a 401 so we
  // don't expose an open trigger for an upstream-traffic-generator.
  const email = authenticatedEmail(request);
  if (!email) return jsonResponse({ error: "not authenticated" }, 401);
  try {
    const report = await refreshPrecons(env, { reason: `manual:${email}`, force: true });
    return jsonResponse({ ok: true, ...report });
  } catch (e) {
    return jsonResponse({ error: e?.message || "refresh failed" }, 500);
  }
}

// ── Auth / identity ─────────────────────────────────────────────────────
// We trust the email header iff there's ALSO a JWT assertion present —
// the JWT is set by Cloudflare Access at the edge and can't be spoofed by
// upstream proxies. If neither is set, the user simply isn't signed in
// (or Access isn't configured yet).
function authenticatedEmail(request) {
  const jwt   = request.headers.get("Cf-Access-Jwt-Assertion");
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (jwt && email) return email.toLowerCase();
  return null;
}

function handleMe(request) {
  const email = authenticatedEmail(request);
  if (!email) return jsonResponse({ authenticated: false });
  return jsonResponse({ authenticated: true, email });
}

// ── Cloud-sync state (per-user KV blob) ─────────────────────────────────
// Stored as one JSON blob per user:
//   { state: { … all syncable keys … }, lastModified: 1234567890 }
// Conflict detection: client sends `expectedLastModified` on PUT. If the
// stored lastModified is newer, we return 409 with the current value so the
// client can merge before retrying.
const KV_USER_PREFIX = "user:";
// Cloudflare KV allows up to 25 MiB per value. 10 MiB is plenty for the
// "everything in one blob per user" model — covers a typical collection
// (2-3 K cards) + 20-30 enriched decks + library + push history with
// generous headroom. The serialised state grew past the original 1 MB
// cap once decks started carrying enriched Scryfall + EDHRec + Spellbook
// + Archidekt payloads. If we ever need more, splitting state into
// per-section KV entries is the next move.
const MAX_STATE_BYTES = 10 * 1024 * 1024;   // 10 MiB hard cap per user

async function handleStateGet(request, env) {
  const email = authenticatedEmail(request);
  if (!email) return jsonResponse({ error: "not authenticated" }, 401);
  if (!env.STATE) return jsonResponse({ error: "sync not configured (no KV binding)" }, 503);

  const key = KV_USER_PREFIX + email;
  const raw = await env.STATE.get(key);
  if (!raw) return jsonResponse({ state: null, lastModified: 0 });

  try {
    const parsed = JSON.parse(raw);
    return jsonResponse({
      state:        parsed.state || null,
      lastModified: parsed.lastModified || 0,
    });
  } catch {
    return jsonResponse({ state: null, lastModified: 0, error: "corrupt state, ignored" });
  }
}

async function handleStatePut(request, env) {
  const email = authenticatedEmail(request);
  if (!email) return jsonResponse({ error: "not authenticated" }, 401);
  if (!env.STATE) return jsonResponse({ error: "sync not configured (no KV binding)" }, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "request body must be JSON" }, 400); }

  const state = body?.state;
  if (!state || typeof state !== "object") {
    return jsonResponse({ error: "missing or invalid `state` object" }, 400);
  }
  const expectedLast = typeof body.expectedLastModified === "number"
    ? body.expectedLastModified
    : null;

  const key = KV_USER_PREFIX + email;

  // Optional conflict check: refuse if the stored state was updated AFTER
  // the client last saw it.
  if (expectedLast !== null) {
    const existing = await env.STATE.get(key);
    if (existing) {
      try {
        const { lastModified: serverLast = 0 } = JSON.parse(existing);
        if (serverLast > expectedLast) {
          return jsonResponse({
            error: "conflict",
            currentLastModified: serverLast,
          }, 409);
        }
      } catch {}
    }
  }

  // Size guard.
  const serialized = JSON.stringify({ state, lastModified: Date.now() });
  if (serialized.length > MAX_STATE_BYTES) {
    const mb = (n) => (n / (1024 * 1024)).toFixed(2);
    return jsonResponse({
      error: `Synced state is too large: ${mb(serialized.length)} MiB (cap ${mb(MAX_STATE_BYTES)} MiB). ` +
             `Trim the library / saved decks, or delete some enriched-deck caches via DevTools to free space.`,
    }, 413);
  }
  const parsedNow = JSON.parse(serialized);
  await env.STATE.put(key, serialized);
  return jsonResponse({ ok: true, lastModified: parsedNow.lastModified });
}

async function handleProxy(request, prefix, target) {
  const url = new URL(request.url);
  const rel = url.pathname.slice(prefix.length);   // path after the prefix
  const upstream = `${target}/${rel}${url.search || ""}`;

  // Build outbound headers — only forward what's safe / needed.
  const outHeaders = new Headers();
  for (const name of FORWARD_REQ_HEADERS) {
    const v = request.headers.get(name);
    if (v) outHeaders.set(name, v);
  }
  outHeaders.set("User-Agent", BROWSER_UA);
  if (!outHeaders.has("Accept")) outHeaders.set("Accept", "application/json, */*;q=0.5");

  // Forward body for non-GET/HEAD methods.
  const init = {
    method: request.method,
    headers: outHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, init);
  } catch (e) {
    return jsonResponse({
      error: `Proxy fetch failed: ${(e?.message || String(e)).slice(0, 200)}`,
      upstream,
    }, 502);
  }

  // Build response headers — drop everything except a small allowlist plus
  // any Set-Cookie (rewritten so the browser stores the cookie under the
  // Worker's hostname, not the upstream's).
  const resHeaders = new Headers();
  for (const name of FORWARD_RES_HEADERS) {
    const v = upstreamRes.headers.get(name);
    if (v) resHeaders.set(name, v);
  }
  // Forward Set-Cookie headers, stripping Domain= so the browser actually
  // accepts the cookie under the Worker's origin.
  const setCookies = upstreamRes.headers.getSetCookie?.() || [];
  for (const raw of setCookies) {
    const rewritten = raw
      .split(";")
      .filter(p => !/^\s*(domain=|secure\b)/i.test(p))
      .join(";")
      .trim();
    if (rewritten) resHeaders.append("Set-Cookie", rewritten);
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: resHeaders,
  });
}

// ── Shared Gemini (host-paid, per-user cap) ─────────────────────────────
// Friends without their own Gemini key can use the host's key (set as the
// GEMINI_API_KEY Worker secret), capped at SHARED_GEMINI_DAILY_CAP requests
// per user per UTC day. Quota keys live in the same STATE namespace, with a
// 25-hour TTL so yesterday's keys self-clean.
const SHARED_GEMINI_DAILY_CAP = 20;
const SHARED_GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const QUOTA_KEY_PREFIX = "quota:";

function quotaKey(email) {
  // UTC date as the bucket. Two friends in different timezones may see the
  // boundary at slightly different "local midnights" — acceptable trade-off.
  const today = new Date().toISOString().slice(0, 10);
  return `${QUOTA_KEY_PREFIX}${today}:${email}`;
}

async function readUsage(env, email) {
  if (!env.STATE) return 0;
  const raw = await env.STATE.get(quotaKey(email));
  const n = parseInt(raw);
  return Number.isFinite(n) ? n : 0;
}

async function bumpUsage(env, email, current) {
  if (!env.STATE) return;
  await env.STATE.put(quotaKey(email), String(current + 1), {
    expirationTtl: 25 * 60 * 60,   // 25h: bucket evaporates after the day ends
  });
}

async function handleQuota(request, env) {
  const email = authenticatedEmail(request);
  if (!email) return jsonResponse({ error: "not authenticated" }, 401);
  const used = await readUsage(env, email);
  return jsonResponse({
    used,
    cap: SHARED_GEMINI_DAILY_CAP,
    remaining: Math.max(0, SHARED_GEMINI_DAILY_CAP - used),
    hasHostKey: !!env.GEMINI_API_KEY,
    syncReady: !!env.STATE,
  });
}

async function handleSharedGemini(request, env) {
  const email = authenticatedEmail(request);
  if (!email) return jsonResponse({ error: "not authenticated" }, 401);
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "Host Gemini key not configured. Paste your own key in Settings." }, 503);
  }
  if (!env.STATE) {
    return jsonResponse({ error: "Per-user quota tracking requires KV — see docs/SYNC_SETUP.md." }, 503);
  }

  // Daily cap check (BEFORE the upstream call — no point in burning quota
  // for a user who's already maxed out).
  const used = await readUsage(env, email);
  if (used >= SHARED_GEMINI_DAILY_CAP) {
    return jsonResponse({
      error: "Daily shared-key cap reached",
      used, cap: SHARED_GEMINI_DAILY_CAP, remaining: 0,
      resetAtUTC: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().slice(0, 10),
    }, 429);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "request body must be JSON" }, 400); }

  const system     = (body.system || "").toString();
  const user       = (body.user   || "").toString();
  const max_tokens = Math.min(parseInt(body.max_tokens) || 4096, 16384);
  const model      = (body.model || SHARED_GEMINI_DEFAULT_MODEL).toString();

  if (!user) return jsonResponse({ error: "missing 'user' field" }, 400);

  // Forward to Gemini using the host's key.
  const isThinking = /^gemini-2\.5/.test(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`;
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: max_tokens, temperature: 0.7,
          responseMimeType: "application/json",
          ...(isThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
  } catch (e) {
    return jsonResponse({
      error: `Gemini fetch failed: ${(e?.message || String(e)).slice(0, 200)}`,
    }, 502);
  }

  let data;
  try { data = await r.json(); }
  catch { return jsonResponse({ error: "Gemini returned non-JSON" }, 502); }

  if (!r.ok) {
    // Don't increment usage — the user didn't actually consume a successful build.
    return jsonResponse({
      error: data.error?.message || `Gemini error ${r.status}`,
    }, r.status);
  }

  // Success — increment counter and shape response to match client's expected
  // contract (matches the shape callGemini() returns when called directly).
  await bumpUsage(env, email, used);

  const cand = data.candidates?.[0] || {};
  return jsonResponse({
    text:             cand.content?.parts?.[0]?.text ?? "",
    finishReason:     (cand.finishReason || "unknown").toLowerCase(),
    completionTokens: data.usageMetadata?.candidatesTokenCount || null,
    promptTokens:     data.usageMetadata?.promptTokenCount     || null,
    thoughtsTokens:   data.usageMetadata?.thoughtsTokenCount   || null,
    quotaUsed:        used + 1,
    quotaCap:         SHARED_GEMINI_DAILY_CAP,
    quotaRemaining:   SHARED_GEMINI_DAILY_CAP - (used + 1),
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
