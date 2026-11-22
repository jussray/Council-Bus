  // @ts-check

  import { describe, expect, it, vi } from "vitest";
  import { createPerplexityRouter } from "./perplexity-router.js";

  const TEST_ENV = {
     PERPLEXITY_API_KEY: "test-upstream-key",
     ROUTER_API_KEY: "test-router-key",
     PERPLEXITY_MODEL: "test-model",
  };

  const COMPLETION = {
    id: "test-completion",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
           role: "assistant",
           content: "Hello from the mock.",
        },
         finish_reason: "stop",
    },
  ],
};

/**
 * @param {Partial<import("./perplexity-router.js").RouterEnv>} [overrides]
 */
function setup(overrides = {}) {
  const create = vi.fn(
     /**
      * @param {import("openai").OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming} _body
      * @returns {Promise<unknown>}
      */
     async (_body) => COMPLETION,
  );

    const openAIClientFactory = vi.fn(
       /**
        * @param {ConstructorParameters<typeof import("openai").default>[0]} options
        */
       (options) => ({
         options,
         chat: {
            completions: {
              create,
           },
         },
      }),
    );

    const sleep = vi.fn(
       /** @param {number} _ms */
       async (_ms) => {},
    );

    const fetchImpl = vi.fn(
       /** @type {typeof globalThis.fetch} */
      (async () => new Response("Unexpected fetch", { status: 500 })),
    );

    const router = createPerplexityRouter({
      env: { ...TEST_ENV, ...overrides },
      openAIClientFactory,
      fetchImpl,
      sleep,
    });

    return {
      router,
      create,
      openAIClientFactory,
      fetchImpl,
      sleep,
    };
}
/**
 * @param {unknown} [body]
 * @param {string} [token]
 */
function chatRequest(
  body = {
    messages: [{ role: "user", content: "Hello" }],
  },
  token = TEST_ENV.ROUTER_API_KEY,
) {
  return new Request(
     "https://router.example/v1/chat/completions",
    {
       method: "POST",
       headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
       },
       body: JSON.stringify(body),
    },
  );
}

describe("createPerplexityRouter", () => {
  it("responds to health checks without credentials", async () => {
    const router = createPerplexityRouter();

   const response = await router.fetch(
      new Request("https://router.example/health"),
   );

   expect(response.status).toBe(200);
   expect(await response.json()).toEqual({ ok: true });
 });

  it("returns 404 for unknown routes", async () => {
    const { router, create } = setup();

   const response = await router.fetch(
      new Request("https://router.example/missing"),
   );

   expect(response.status).toBe(404);
   expect(create).not.toHaveBeenCalled();
 });

  it("allows only GET on /health", async () => {
    const { router } = setup();

   const response = await router.fetch(
      new Request("https://router.example/health", {
        method: "POST",
     }),
   );
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
});

it("allows only POST on the completions route", async () => {
  const { router } = setup();

 const response = await router.fetch(
    new Request("https://router.example/v1/chat/completions"),
 );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
});

it("fails closed when inbound authentication is unconfigured", async () => {
  const { router, create } = setup({ ROUTER_API_KEY: "" });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(503);
  expect(create).not.toHaveBeenCalled();
});

it("rejects an incorrect inbound token", async () => {
  const { router, create } = setup();

 const response = await router.fetch(
    chatRequest(undefined, "incorrect-token"),
 );

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
  expect(create).not.toHaveBeenCalled();
});

it("rejects a missing, prefixed, or length-shifted inbound token", async () => {
  const { router, create } = setup();
  const url = "https://router.example/v1/chat/completions";
  const body = JSON.stringify({ messages: [{ role: "user", content: "Hello" }] });
  for (const authorization of [
    undefined,
    `Bearer ${TEST_ENV.ROUTER_API_KEY.slice(0, -1)}`,
    `Bearer ${TEST_ENV.ROUTER_API_KEY}x`,
    TEST_ENV.ROUTER_API_KEY,
  ]) {
    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/json" };
    if (authorization !== undefined) headers.authorization = authorization;
    const response = await router.fetch(new Request(url, { method: "POST", headers, body }));
    expect(response.status).toBe(401);
  }
  expect(create).not.toHaveBeenCalled();
});

it("rejects requests when the upstream key is missing", async () => {
  const { router, create } = setup({
    PERPLEXITY_API_KEY: "",
  });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(503);
  expect(create).not.toHaveBeenCalled();
});

it("rejects malformed JSON", async () => {
  const { router, create } = setup();

  const response = await router.fetch(
    new Request("https://router.example/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_ENV.ROUTER_API_KEY}`,
        "content-type": "application/json",
     },
     body: "{",
   }),
 );

  expect(response.status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});

it.each([
  null,
  {},
  { messages: [] },
  { messages: [{ role: "unknown", content: "Hello" }] },
  { messages: [{ role: "user", content: 123 }] },
  {
     messages: [{ role: "user", content: "Hello" }],
     stream: true,
  },
  {
     messages: [{ role: "user", content: "Hello" }],
     temperature: 3,
  },
  {
     messages: [{ role: "user", content: "Hello" }],
     max_tokens: 0,
  },
])("rejects an invalid request body: %j", async (body) => {
  const { router, create } = setup();

  const response = await router.fetch(chatRequest(body));

  expect(response.status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});

it("requires a request model or configured default", async () => {
  const { router, create } = setup({
    PERPLEXITY_MODEL: "",
  });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});

it("returns the upstream completion", async () => {
  const {
    router,
    create,
    openAIClientFactory,
    fetchImpl,
  } = setup();

  const response = await router.fetch(chatRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(COMPLETION);

 expect(create).toHaveBeenCalledWith({
   model: "test-model",
   messages: [{ role: "user", content: "Hello" }],
   stream: false,
 });

 expect(openAIClientFactory).toHaveBeenCalledWith({
   apiKey: TEST_ENV.PERPLEXITY_API_KEY,
   baseURL: "https://api.perplexity.ai/orchestrator/v1",
   fetch: fetchImpl,
   timeout: 30_000,
   maxRetries: 0,
 });

  expect(fetchImpl).not.toHaveBeenCalled();
});

it("forwards supported options and a request-level model", async () => {
  const { router, create } = setup();

 const response = await router.fetch(
    chatRequest({
      model: "request-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.5,
      max_tokens: 100,
   }),
 );

  expect(response.status).toBe(200);
  expect(create).toHaveBeenCalledWith({
    model: "request-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    temperature: 0.5,
    max_tokens: 100,
  });
});

it("lets runtime bindings override factory environment defaults", async () => {
  const { router, openAIClientFactory } = setup();

 const response = await router.fetch(
    chatRequest(undefined, "runtime-router-key"),
   {
      ROUTER_API_KEY: "runtime-router-key",
      PERPLEXITY_API_KEY: "runtime-upstream-key",
      PERPLEXITY_MODEL: "runtime-model",
   },
 );

  expect(response.status).toBe(200);
  expect(openAIClientFactory).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "runtime-upstream-key",
    }),
  );
});

it("retries a transient upstream failure", async () => {
  const { router, create, sleep } = setup();

 create.mockRejectedValueOnce({ status: 503 });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(200);
  expect(create).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
});

it("stops after three attempts on rate limits", async () => {
  const { router, create, sleep } = setup();

 create.mockRejectedValue({ status: 429 });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(429);
  expect(create).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls).toEqual([[250], [500]]);
});

it("maps exhausted upstream server errors to 502", async () => {
  const { router, create } = setup();

 create.mockRejectedValue({ status: 503 });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(502);
  expect(create).toHaveBeenCalledTimes(3);
});

it("does not retry permanent upstream errors or expose details", async () => {
  const { router, create, sleep } = setup();

 create.mockRejectedValue({
   status: 401,
   message: "Sensitive upstream diagnostic",
 });

  const response = await router.fetch(chatRequest());

  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("Sensitive");
  expect(create).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
      });

      it("handles client initialization failures", async () => {
        const router = createPerplexityRouter({
          env: TEST_ENV,
          openAIClientFactory: () => {
             throw new Error("Sensitive initialization diagnostic");
          },
        });

        const response = await router.fetch(chatRequest());

      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("Sensitive");
    });
  });
