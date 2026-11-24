  // @ts-check

  import OpenAI from "openai";

  /**
   * @typedef {object} RouterEnv
   * @property {string} [PERPLEXITY_API_KEY]
   * @property {string} [PERPLEXITY_MODEL]
   * @property {string} [ROUTER_API_KEY]
   */

  /**
   * A deliberately small client contract so tests don't need to
   * implement the entire OpenAI SDK.
   *
   * @typedef {object} RouterClient
   * @property {{
   * completions: {
   *     create: (
   *       body: import("openai").OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
   *     ) => PromiseLike<unknown>
   *   }
   * }} chat
   */

  /**
   * @typedef {object} RouterOptions
   * @property {RouterEnv} [env]
   * @property {typeof globalThis.fetch} [fetchImpl]
   * @property {(
   * options: ConstructorParameters<typeof OpenAI>[0]
   * ) => RouterClient} [openAIClientFactory]
   * @property {(ms: number) => Promise<void>} [sleep]
   */

  /**
   * @typedef {object} ChatBody
   * @property {string} [model]
   * @property {{role: "system" | "user" | "assistant", content: string}[]} messages
   * @property {number} [temperature]
* @property {number} [max_tokens]
*/

const BASE_URL = "https://api.perplexity.ai/orchestrator/v1";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Constant-time string comparison. Both inputs are hashed to fixed-length
 * SHA-256 digests first, so neither content nor length leaks through timing.
 * Uses the Workers-native crypto.subtle.timingSafeEqual when present, and a
 * branch-free XOR fold otherwise (Node, tests).
 *
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  /** @type {{ timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean }} */
  const subtle = /** @type {any} */ (crypto.subtle);
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(da, db);
  }
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is ChatBody}
 */
function isChatBody(value) {
  if (!isRecord(value)) return false;

 if (
   !Array.isArray(value.messages) ||
   value.messages.length === 0
 ) {
   return false;
 }

  for (const message of value.messages) {
    if (!isRecord(message)) return false;

     if (
       message.role !== "system" &&
       message.role !== "user" &&
       message.role !== "assistant"
     ) {
       return false;
     }

     if (typeof message.content !== "string") return false;
 }

 if (
   value.model !== undefined &&
   (typeof value.model !== "string" || !value.model.trim())
 ) {
   return false;
 }

  if (
    value.temperature !== undefined &&
    (
       typeof value.temperature !== "number" ||
      !Number.isFinite(value.temperature) ||
      value.temperature < 0 ||
      value.temperature > 2
      )
    ) {
      return false;
    }

    if (
      value.max_tokens !== undefined &&
      (
         typeof value.max_tokens !== "number" ||
        !Number.isInteger(value.max_tokens) ||
        value.max_tokens <= 0
      )
    ) {
      return false;
    }

    // This starter intentionally supports non-streaming requests only.
    if (value.stream !== undefined && value.stream !== false) {
      return false;
    }

    return true;
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
       "content-type": "application/json; charset=utf-8",
       "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [headers]
 */
function errorResponse(message, status, headers) {
  return json({ error: { message } }, status, headers);
}

/**
 * @param {unknown} error
 * @returns {number | undefined}
 */
function upstreamStatus(error) {
  if (
    isRecord(error) &&
      typeof error.status === "number" &&
      Number.isInteger(error.status)
    ) {
      return error.status;
    }

    return undefined;
}

/**
 * Create an independently testable router.
 *
 * Environment bindings passed to fetch() override the factory defaults.
 *
 * @param {RouterOptions} [options]
 */
export function createPerplexityRouter({
  env = {},
  fetchImpl = globalThis.fetch,
  openAIClientFactory = (options) => new OpenAI(options),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
   return {
     /**
      * @param {Request} request
      * @param {RouterEnv} [runtimeEnv]
      * @returns {Promise<Response>}
      */
     async fetch(request, runtimeEnv = {}) {
       const bindings = { ...env, ...runtimeEnv };
       const { pathname } = new URL(request.url);

        if (pathname === "/health") {
          if (request.method !== "GET") {
            return errorResponse("Method not allowed", 405, {
              allow: "GET",
            });
          }

           return json({ ok: true });
       }

       if (pathname !== "/v1/chat/completions") {
         return errorResponse("Not found", 404);
       }

       if (request.method !== "POST") {
         return errorResponse("Method not allowed", 405, {
           allow: "POST",
         });
       }

        // Fail closed: require an inbound credential rather than
        // accidentally exposing a public, billable proxy.
        if (!bindings.ROUTER_API_KEY) {
          return errorResponse("Router authentication is not configured", 503);
}

if (
  !(await safeEqual(
    request.headers.get("authorization") ?? "",
    `Bearer ${bindings.ROUTER_API_KEY}`,
  ))
) {
  return errorResponse("Unauthorized", 401, {
    "www-authenticate": "Bearer",
  });
}

if (!bindings.PERPLEXITY_API_KEY) {
  return errorResponse("Upstream API key is not configured", 503);
}

let body;

try {
  body = await request.json();
} catch {
  return errorResponse("Request body must be valid JSON", 400);
}

if (!isChatBody(body)) {
  return errorResponse(
     "Expected nonempty messages with system/user/assistant roles " +
     "and string content. Only non-streaming requests are supported.",
     400,
  );
}

const model = body.model ?? bindings.PERPLEXITY_MODEL;

if (!model || !model.trim()) {
  return errorResponse(
     "Supply a model or configure PERPLEXITY_MODEL",
     400,
  );
}

/** @type {import("openai").OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming} */
const payload = {
  model,
   messages: body.messages,
   stream: false,
  ...(body.temperature !== undefined
     ? { temperature: body.temperature }
     : {}),
  ...(body.max_tokens !== undefined
     ? { max_tokens: body.max_tokens }
     : {}),
};

try {
  const client = openAIClientFactory({
    apiKey: bindings.PERPLEXITY_API_KEY,
               baseURL: BASE_URL,
               fetch: fetchImpl,
               timeout: 30_000,

             // Keep retry policy here instead of stacking SDK retries.
             maxRetries: 0,
           });

            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                const completion = await client.chat.completions.create(payload);
                return json(completion);
              } catch (error) {
                const status = upstreamStatus(error);

                   if (
                     status !== undefined &&
                     RETRYABLE_STATUSES.has(status) &&
                     attempt < 2
                   ) {
                     await sleep(250 * 2 ** attempt);
                     continue;
                   }

                   if (status === 429) {
                     return errorResponse("Upstream rate limit exceeded", 429);
                   }

                   // Don't expose provider errors, credentials, or internals.
                   return errorResponse("Upstream request failed", 502);
               }
           }

            return errorResponse("Upstream request failed", 502);
          } catch {
            return errorResponse("Unable to initialize upstream client", 502);
          }
        },
      };
  }

  export default createPerplexityRouter();
