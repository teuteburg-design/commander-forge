// Commander Forge — Cloudflare Worker entry point.
//
// Routes:
//   POST /api/ai     → run a prompt through Workers AI Llama 3.1 8B
//   /edhrec/*        → proxy GET to json.edhrec.com (CORS sidestep)
//   /spellbook/*     → proxy POST to backend.commanderspellbook.com (CORS sidestep)
//   /archidekt/*     → proxy any method to archidekt.com (CORS sidestep + auth header forwarding)
//   anything else    → fall through to ASSETS (static files in ./public)
//
// The /api/ai endpoint exists so friends visiting the live site don't need to
// supply their own Groq / Gemini key. They share the host's Workers AI quota
// (~10 000 neurons/day, free tier). Friends can still paste their own keys in
// Settings to use Groq or Gemini for higher-quality output.
//
// The proxy routes mirror what proxy.py does for local development. They exist
// because:
//   - EDHRec / Cloudflare-fronted endpoints fingerprint browser fetches and
//     occasionally CORS-block the response.
//   - Spellbook's find-my-combos POST isn't CORS-friendly.
//   - Archidekt's API has no documented browser-CORS allowance at all.

const MODEL = "@cf/meta/llama-3.1-8b-instruct";   // best free-tier instruct model
const HARD_MAX_TOKENS = 4096;

// Path prefix → upstream base URL. Order matters only for the AI route which
// is checked first. Each request hitting one of these prefixes is forwarded
// server-side; the browser sees a same-origin response.
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

    if (url.pathname === "/api/ai") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST only" }, 405);
      }
      return handleAI(request, env);
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

async function handleAI(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "request body must be JSON" }, 400);
  }

  const system     = (body.system || "").toString();
  const user       = (body.user   || "").toString();
  const max_tokens = Math.min(parseInt(body.max_tokens) || 4096, HARD_MAX_TOKENS);

  if (!user) return jsonResponse({ error: "missing 'user' field" }, 400);

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  try {
    // NOTE: Llama 3.1 8B on Workers AI does NOT accept response_format =
    // { type: "json_object" } (returns "unknown variant 'json_object'…
    // expected 'json_schema'"). We rely on the system prompt asking for
    // JSON and on safeParse() in the client to tolerate prose wrappers.
    const result = await env.AI.run(MODEL, { messages, max_tokens });

    const content = typeof result === "string"
      ? result
      : (result?.response ?? JSON.stringify(result));

    return jsonResponse({ content, model: MODEL });
  } catch (e) {
    return jsonResponse({
      error: (e?.message || String(e)).slice(0, 300),
      model: MODEL,
    }, 502);
  }
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
