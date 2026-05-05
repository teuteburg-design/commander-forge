// Commander Forge — Cloudflare Worker entry point.
//
// Routes:
//   POST /api/ai   → run a prompt through Workers AI Llama 3.1 8B
//   anything else  → fall through to ASSETS (static files in ./public)
//
// The AI endpoint exists so friends visiting the live site don't need to
// supply their own Groq / Gemini key. They share the host's Workers AI
// quota (~10 000 neurons/day, free tier). Friends can still paste their
// own keys in Settings to use Groq or Gemini for higher-quality output.

const MODEL = "@cf/meta/llama-3.1-8b-instruct";   // best free-tier instruct model
const HARD_MAX_TOKENS = 4096;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ai") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST only" }, 405);
      }
      return handleAI(request, env);
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
    const result = await env.AI.run(MODEL, {
      messages,
      max_tokens,
      // Workers AI honours response_format on Llama 3.1 8B; falls back to
      // free-form text on models that don't, which our safeParse handles.
      response_format: { type: "json_object" },
    });

    // Workers AI returns either { response: "..." } or sometimes the raw object.
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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
