// Council-Bus seat router: one module, deployed as one Worker per seat.
//
// Each Worker sets SEAT (claude | chatgpt | deepseek | muse | perplexity) and
// holds only that seat's provider key, so a leaked key reaches one seat only.
// Provider endpoints, request bodies, model allowlists and reply parsing
// mirror Founder Control Room's operator relay (src/lib/operatorRelayModelProviders.ts
// and operatorRelayMuseProvider.ts on FCR main b8e0c3b). This is a parallel
// path chosen by the founder, not a replacement for FCR's relay.
//
// Contract: POST /v1/chat/completions  {messages: [{role, content}]}
//   Authorization: Bearer <ROUTER_API_KEY>
// Reply: a chat.completion envelope (so scripts/seat_adapter.py works for every
// seat) plus `seat` and `provider: {endpoint, status, raw}`, where `raw` is
// the provider's exact response text for audit.
// The model comes only from SEAT_MODEL (founder-configured), never the caller.
// Fails closed and never substitutes a different seat or provider.

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_INPUT_CHARS = 48_000;
const MAX_ID_LENGTH = 200;
const ANTHROPIC_API_VERSION = "2026-10-21";
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/** @typedef {Record<string, unknown>} JsonRecord */

/** @param {unknown} v @returns {JsonRecord | null} */
function record(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? /** @type {JsonRecord} */ (v) : null;
}

/** Text of a Responses-API style body: status completed, output[].content[].output_text. */
function responsesText(body, { typed = true, outputText = true } = {}) {
  if (body.status !== "completed") throw new Error("non-completed response");
  if (outputText && typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }
  const parts = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    const message = record(item);
    if (typed && message?.type !== "message") continue;
    for (const entry of Array.isArray(message?.content) ? message.content : []) {
      const block = record(entry);
      if ((!typed || block?.type === "output_text") && typeof block?.text === "string" && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  if (parts.length === 0) throw new Error("no text");
  return parts.join("\n");
}

function anthropicText(body) {
  if (body.type !== "message" || body.role !== "assistant") throw new Error("invalid message envelope");
  const parts = (Array.isArray(body.content) ? body.content : []).flatMap((entry) => {
    const block = record(entry);
    return block?.type === "text" && typeof block.text === "string" && block.text.trim() ? [block.text.trim()] : [];
  });
  if (parts.length === 0) throw new Error("no text");
  return parts.join("\n");
}

/** Flatten chat messages into one prompt, as FCR's relayPrompt sends a single input string. */
function prompt(messages) {
  return messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
}

function responsesRequest(endpoint, extra = {}) {
  return (key, model, messages) => ({
    url: endpoint,
    init: {
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: prompt(messages), max_output_tokens: MAX_OUTPUT_TOKENS, ...extra }),
    },
  });
}

/** Per-seat provider table. Keep in step with FCR's relay providers. */
export const SEATS = Object.freeze({
  chatgpt: {
    provider: "openai",
    keyEnv: "OPENAI_API_KEY",
    model: (v) => (/^[A-Za-z0-9._-]{1,160}$/.test(v) ? v : null),
    request: responsesRequest("https://api.openai.com/v1/responses", { store: false }),
    text: (b) => responsesText(b, { typed: false }),
  },
  claude: {
    provider: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    model: (v) => (/^[A-Za-z0-9._-]{1,160}$/.test(v) ? v : null),
    request: (key, model, messages) => {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const rest = messages.filter((m) => m.role !== "system");
      return {
        url: "https://api.anthropic.com/v1/messages",
        init: {
          headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            ...(system ? { system } : {}),
            messages: [{ role: "user", content: prompt(rest) }],
          }),
        },
      };
    },
    text: anthropicText,
  },
  deepseek: {
    provider: "deepseek",
    keyEnv: "DEEPSEEK_API_KEY",
    model: (v) => (/^(?:deepseek-flash|deepseek-v4-pro)$/.test(v) ? v : null),
    request: responsesRequest("https://api.deepseek.com/responses"),
    text: (b) => responsesText(b),
  },
  muse: {
    provider: "meta",
    keyEnv: "MUSE_API_KEY",
    model: (v) => (/^muse-spark-1\.(?:1|2|3)$/.test(v) ? v : null),
    request: responsesRequest("https://api.meta.ai/v1/responses", { store: false }),
    text: (b) => responsesText(b),
  },
  perplexity: {
    provider: "perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    model: (v) => {
      if (v === "sonar") return "perplexity/sonar";
      return v.length <= 160 && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v) ? v : null;
    },
    request: responsesRequest("https://api.perplexity.ai/v1/agent", { tools: [{ type: "web_search" }], store: false }),
    text: (b) => responsesText(b, { outputText: false }),
  },
});

/** Constant-time comparison over SHA-256 digests (no content or length leak). */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const subtle = /** @type {any} */ (crypto.subtle);
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(da, db);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const fail = (message, status, headers) => json({ error: { message } }, status, headers);

function validMessages(body) {
  const b = record(body);
  if (!b || !Array.isArray(b.messages) || b.messages.length === 0) return null;
  let total = 0;
  for (const m of b.messages) {
    const r = record(m);
    if (!r || !["system", "user", "assistant"].includes(/** @type {string} */ (r.role))) return null;
    if (typeof r.content !== "string") return null;
    total += r.content.length;
  }
  if (total === 0 || total > MAX_INPUT_CHARS) return null;
  return /** @type {{role: string, content: string}[]} */ (b.messages);
}

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createSeatRouter({ fetchImpl = globalThis.fetch, beforeProvider = null, useRequestTimeout = true } = {}) {
  return {
    /** @param {Request} request @param {Record<string, string | undefined>} env */
    async fetch(request, env = {}) {
      const { pathname } = new URL(request.url);
      const seatName = (env.SEAT ?? "").trim();
      const seat = Object.prototype.hasOwnProperty.call(SEATS, seatName) ? SEATS[seatName] : null;

      if (pathname === "/health") {
        if (request.method !== "GET") return fail("Method not allowed", 405, { allow: "GET" });
        return json({ ok: Boolean(seat), seat: seat ? seatName : null });
      }
      if (pathname !== "/v1/chat/completions") return fail("Not found", 404);
      if (request.method !== "POST") return fail("Method not allowed", 405, { allow: "POST" });
      if (!seat) return fail("SEAT is not configured to a known seat", 503);
      if (!env.ROUTER_API_KEY) return fail("Router authentication is not configured", 503);
      if (!(await safeEqual(request.headers.get("authorization") ?? "", `Bearer ${env.ROUTER_API_KEY}`))) {
        return fail("Unauthorized", 401, { "www-authenticate": "Bearer" });
      }
      const key = env[seat.keyEnv]?.trim();
      if (!key) return fail(`${seat.keyEnv} is not configured for seat ${seatName}`, 503);
      const model = seat.model((env.SEAT_MODEL ?? "").trim());
      if (!model) return fail(`SEAT_MODEL is missing or not allowed for seat ${seatName}`, 503);

      let body;
      try {
        body = await request.json();
      } catch {
        return fail("Request body must be valid JSON", 400);
      }
      const messages = validMessages(body);
      if (!messages) {
        return fail(`Expected nonempty messages (system/user/assistant, string content, at most ${MAX_INPUT_CHARS} characters)`, 400);
      }

      // Optional gate for the consolidated Worker. Run only AFTER authentication
      // and request validation; legacy per-seat Workers remain unchanged.
      if (beforeProvider) {
        let permitted;
        try {
          permitted = await beforeProvider({ request, env, seat: seatName });
        } catch {
          return fail("Rate limiting unavailable", 503);
        }
        if (permitted === false) return fail("Rate limit exceeded", 429);
        if (permitted !== true) return fail("Rate limiting unavailable", 503);
      }

      const { url, init } = seat.request(key, model, messages);
      let response;
      try {
        response = await fetchImpl(url, { method: "POST", redirect: "error", ...(useRequestTimeout ? { signal: AbortSignal.timeout(TIMEOUT_MS) } : {}), ...init });
      } catch {
        return fail(`${seat.provider} request failed`, 502);
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* provider error bodies are never echoed */ }
        return fail(`${seat.provider} returned HTTP ${response.status}`, response.status === 429 ? 429 : 502);
      }

      let raw;
      let parsed;
      let content;
      try {
        raw = await boundedText(response);
        parsed = record(JSON.parse(raw));
        if (!parsed) throw new Error("not an object");
        content = seat.text(parsed);
      } catch {
        return fail(`${seat.provider} returned an invalid response`, 502);
      }
      const rawId = typeof parsed.id === "string" ? parsed.id.trim() : "";
      const id = rawId && rawId.length <= MAX_ID_LENGTH && SAFE_ID.test(rawId) ? rawId : "unidentified-response";

      return json({
        id,
        object: "chat.completion",
        model,
        seat: seatName,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        provider: { name: seat.provider, endpoint: url, status: response.status, raw },
      });
    },
  };
}

export default createSeatRouter();
