// Commander Forge — Cloudflare Worker entry point.
//
// Routes:
//   GET  /api/me         → returns the authenticated user's email (or {auth:false} when
//                          Cloudflare Access isn't configured / no JWT present)
//   GET  /api/state      → loads the user's cloud-synced app state from KV
//   PUT  /api/state      → saves the user's cloud-synced app state to KV
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
  "/edhrec/":    "https://json.edhrec.com",
  "/spellbook/": "https://backend.commanderspellbook.com",
  "/archidekt/": "https://archidekt.com",
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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
