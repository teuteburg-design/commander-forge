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

    // Match against proxy routes. First-prefix-wins.
    for (const [prefix, target] of Object.entries(PROXY_ROUTES)) {
      if (url.pathname.startsWith(prefix)) {
        return handleProxy(request, prefix, target);
      }
    }

    // Everything else: static asset.
    return env.ASSETS.fetch(request);
  },
};

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
const MAX_STATE_BYTES = 1024 * 1024;   // 1 MB hard cap per user

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
    return jsonResponse({
      error: `state too large (${serialized.length} bytes, max ${MAX_STATE_BYTES}). ` +
             `The Scryfall cache should not be synced — strip it out client-side.`,
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
