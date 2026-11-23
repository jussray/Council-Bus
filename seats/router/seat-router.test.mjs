import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeatRouter, SEATS } from "./seat-router.js";

const ROUTER_KEY = "router-secret";

function responsesBody(text, extra = {}) {
  return { id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], ...extra };
}

const CASES = {
  chatgpt: {
    env: { OPENAI_API_KEY: "ok-openai", SEAT_MODEL: "gpt-x" },
    url: "https://api.openai.com/v1/responses",
    auth: (h) => assert.equal(h.authorization, "Bearer ok-openai"),
    reply: responsesBody("chatgpt says hi"),
    want: "chatgpt says hi",
  },
  claude: {
    env: { ANTHROPIC_API_KEY: "ok-anthropic", SEAT_MODEL: "claude-x" },
    url: "https://api.anthropic.com/v1/messages",
    auth: (h) => {
      assert.equal(h["x-api-key"], "ok-anthropic");
      assert.equal(h["anthropic-version"], "2026-10-21");
      assert.equal(h.authorization, undefined);
    },
    reply: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "claude says hi" }] },
    want: "claude says hi",
  },
  deepseek: {
    env: { DEEPSEEK_API_KEY: "ok-deepseek", SEAT_MODEL: "deepseek-flash" },
    url: "https://api.deepseek.com/responses",
    auth: (h) => assert.equal(h.authorization, "Bearer ok-deepseek"),
    reply: responsesBody("deepseek says hi"),
    want: "deepseek says hi",
  },
  muse: {
    env: { MUSE_API_KEY: "ok-muse", SEAT_MODEL: "muse-spark-1.2" },
    url: "https://api.meta.ai/v1/responses",
    auth: (h) => assert.equal(h.authorization, "Bearer ok-muse"),
    reply: responsesBody("muse says hi"),
    want: "muse says hi",
  },
  perplexity: {
    env: { PERPLEXITY_API_KEY: "ok-pplx", SEAT_MODEL: "sonar" },
    url: "https://api.perplexity.ai/v1/agent",
    auth: (h) => assert.equal(h.authorization, "Bearer ok-pplx"),
    reply: responsesBody("perplexity says hi"),
    want: "perplexity says hi",
    model: "perplexity/sonar",
  },
};

function fakeFetch(status, body, calls = []) {
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

function req({ token = ROUTER_KEY, body, path = "/v1/chat/completions", method = "POST" } = {}) {
  const payload = body ?? { model: "caller-chosen", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }] };
  return new Request(`https://router.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
}

function env(seat, extra = {}) {
  return { SEAT: seat, ROUTER_API_KEY: ROUTER_KEY, ...CASES[seat].env, ...extra };
}

test("every bus seat has a provider", () => {
  assert.deepEqual(Object.keys(SEATS).sort(), Object.keys(CASES).sort());
});

for (const [seat, c] of Object.entries(CASES)) {
  test(`${seat}: calls its own provider and returns a chat.completion envelope`, async () => {
    const fetchImpl = fakeFetch(200, c.reply);
    const res = await createSeatRouter({ fetchImpl }).fetch(req(), env(seat));
    assert.equal(res.status, 200);
    const out = await res.json();
    const [call] = fetchImpl.calls;
    assert.equal(call.url, c.url);
    assert.equal(call.init.redirect, "manual");
    c.auth(call.init.headers);
    assert.equal(call.body.model, c.model ?? c.env.SEAT_MODEL, "model comes from SEAT_MODEL, never the caller");
    assert.equal(out.seat, seat);
    assert.equal(out.object, "chat.completion");
    assert.equal(out.choices[0].message.content, c.want);
    assert.equal(out.provider.endpoint, c.url);
    assert.equal(out.provider.raw, JSON.stringify(c.reply), "raw provider text is preserved for audit");
    const sent = JSON.stringify(call.body);
    assert.ok(sent.includes("hello") && sent.includes("be brief"));
  });
}

test("health reports the configured seat", async () => {
  const r = createSeatRouter({ fetchImpl: fakeFetch(200, {}) });
  assert.deepEqual(await (await r.fetch(req({ path: "/health", method: "GET" }), { SEAT: "muse" })).json(), { ok: true, seat: "muse" });
  assert.deepEqual(await (await r.fetch(req({ path: "/health", method: "GET" }), { SEAT: "nope" })).json(), { ok: false, seat: null });
  for (const SEAT of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
    assert.deepEqual(await (await r.fetch(req({ path: "/health", method: "GET" }), { SEAT })).json(), { ok: false, seat: null }, SEAT);
  }
});

test("auth: missing, wrong and unconfigured router key", async () => {
  const fetchImpl = fakeFetch(200, CASES.deepseek.reply);
  const r = createSeatRouter({ fetchImpl });
  assert.equal((await r.fetch(req({ token: "" }), env("deepseek"))).status, 401);
  assert.equal((await r.fetch(req({ token: "router-secreT" }), env("deepseek"))).status, 401);
  assert.equal((await r.fetch(req({ token: `${ROUTER_KEY}x` }), env("deepseek"))).status, 401);
  assert.equal((await r.fetch(req(), env("deepseek", { ROUTER_API_KEY: "" }))).status, 503);
  assert.equal(fetchImpl.calls.length, 0);
});

test("fails closed on unknown seat, missing key, disallowed model; never substitutes", async () => {
  const fetchImpl = fakeFetch(200, CASES.deepseek.reply);
  const r = createSeatRouter({ fetchImpl });
  for (const e of [
    env("deepseek", { SEAT: "gemini" }),
    env("deepseek", { SEAT: "__proto__" }),
    env("deepseek", { DEEPSEEK_API_KEY: "" }),
    env("deepseek", { SEAT_MODEL: "gpt-5" }),
    env("muse", { SEAT_MODEL: "muse-spark-2.0" }),
    env("perplexity", { SEAT_MODEL: "not a model" }),
  ]) {
    const res = await r.fetch(req(), e);
    assert.equal(res.status, 503, JSON.stringify(e));
  }
  const missing = await (await r.fetch(req(), env("claude", { ANTHROPIC_API_KEY: undefined }))).json();
  assert.match(missing.error.message, /ANTHROPIC_API_KEY is not configured for seat claude/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("rejects bad request bodies", async () => {
  const r = createSeatRouter({ fetchImpl: fakeFetch(200, CASES.muse.reply) });
  for (const body of [{}, { messages: [] }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: 1 }] },
    { messages: [{ role: "user", content: "" }] }, { messages: [{ role: "user", content: "x".repeat(48_001) }] }]) {
    assert.equal((await r.fetch(req({ body }), env("muse"))).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const notJson = new Request("https://router.test/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${ROUTER_KEY}` }, body: "{" });
  assert.equal((await r.fetch(notJson, env("muse"))).status, 400);
  assert.equal((await r.fetch(req({ path: "/v1/other" }), env("muse"))).status, 404);
  assert.equal((await r.fetch(req({ method: "GET" }), env("muse"))).status, 405);
});

test("provider errors are mapped, never echoed", async () => {
  for (const [status, want] of [[401, 502], [500, 502], [429, 429]]) {
    const res = await createSeatRouter({ fetchImpl: fakeFetch(status, { error: "upstream-detail-SECRET" }) }).fetch(req(), env("chatgpt"));
    assert.equal(res.status, want);
    assert.ok(!(await res.text()).includes("upstream-detail-SECRET"));
  }
  const thrown = await createSeatRouter({ fetchImpl: async () => { throw new Error("dns SECRET"); } }).fetch(req(), env("chatgpt"));
  assert.equal(thrown.status, 502);
  assert.ok(!(await thrown.text()).includes("SECRET"));
});

test("invalid provider replies fail closed", async () => {
  const bad = [
    [ "deepseek", { id: "r", status: "in_progress", output_text: "partial" } ],
    [ "deepseek", { id: "r", status: "completed", output: [] } ],
    [ "perplexity", { id: "r", status: "completed", output_text: "perplexity must use output[] blocks" } ],
    [ "claude", { id: "m", type: "message", role: "user", content: [{ type: "text", text: "x" }] } ],
    [ "claude", { id: "m", type: "message", role: "assistant", content: [{ type: "tool_use" }] } ],
    [ "muse", "not json" ],
    [ "muse", "[1,2]" ],
    [ "muse", JSON.stringify(responsesBody("x".repeat(70 * 1024))) ],
  ];
  for (const [seat, body] of bad) {
    const res = await createSeatRouter({ fetchImpl: fakeFetch(200, body) }).fetch(req(), env(seat));
    assert.equal(res.status, 502, `${seat}: ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 60)}`);
  }
});

test("unsafe provider ids are not passed through", async () => {
  const res = await createSeatRouter({ fetchImpl: fakeFetch(200, responsesBody("ok", { id: "<script>" })) }).fetch(req(), env("muse"));
  assert.equal((await res.json()).id, "unidentified-response");
});


test("outbound fetch failures expose only safe exception categories, never raw details",async () => {
  const cases=[
    [{name:"TypeError",message:"fetch failed AUTH=Bearer very-private"}, "type_error"],
    [{name:"TypeError",message:"Cannot perform I/O on behalf of a different request context; secret-private"}, "request_context"],
    [{name:"AbortError",message:"private upstream details"}, "aborted"],
    [{name:"TimeoutError",message:"private upstream details"}, "timeout"],
    [{name:"Error",message:"getaddrinfo ENOTFOUND private.host",cause:{code:"ENOTFOUND"}}, "dns"],
    [{name:"Error",message:"private tls detail",cause:{code:"CERT_HAS_EXPIRED"}}, "tls"],
    [{name:"Error",message:"private connection details",cause:{code:"ECONNREFUSED"}}, "connection_refused"],
    [{name:"Error",message:"private-only-misleading-text",cause:{code:"UNTRUSTED_UNK"}}, "unclassified"],
  ];
  for(const [details,expected] of cases){
    const res=await createSeatRouter({
      fetchImpl:async()=>{const err=new Error(details.message);err.name=details.name; if(details.cause)err.cause=details.cause; throw err;},
      useRequestTimeout:false,
    }).fetch(req(),env("chatgpt"));
    assert.equal(res.status,502,expected);
    const result=await res.json();
    assert.equal(result.error.message,"openai request failed");
    assert.equal(result.error.diagnostic,expected);
    const response=JSON.stringify(result);
    assert.ok(!response.includes("private"),expected);
    assert.ok(!response.includes("Bearer"),expected);
    assert.ok(!response.includes("UNTRUSTED"),expected);
  }
});


test("Workers-compatible fetch mode rejects redirects without forwarding provider credentials", async () => {
  for (const seat of Object.keys(CASES)) {
    let calls = 0;
    const fetchImpl=async (url, init) => {
      calls++;
      // Workerd throws TypeError for redirect:"error" before any network I/O.
      if (init.redirect !== "manual") throw new TypeError("Invalid redirect value");
      assert.equal(url, CASES[seat].url);
      return new Response(null,{status:302,headers:{location:"https://attacker.invalid/steal-token"}});
    };
    const res=await createSeatRouter({fetchImpl,useRequestTimeout:false}).fetch(req(),env(seat));
    assert.equal(calls,1,seat);
    assert.equal(res.status,502,seat);
    const body=await res.text();
    assert.ok(!body.includes("attacker.invalid"),seat);
    assert.ok(!body.includes("ok-openai"),seat);
    assert.ok(!body.includes("ok-anthropic"),seat);
    assert.match(body,/redirect/i,seat);
  }
});

test("Workers-compatible manual mode permits successful direct provider responses", async () => {
  let networkCalls=0;
  const fetchImpl=async (url,init)=>{
    networkCalls++;
    if(init.redirect!=="manual")throw new TypeError("Invalid redirect value");
    assert.equal(url,CASES.chatgpt.url);
    return Response.json(CASES.chatgpt.reply);
  };
  const res=await createSeatRouter({fetchImpl,useRequestTimeout:false}).fetch(req(),env("chatgpt"));
  assert.equal(res.status,200);
  assert.equal((await res.json()).choices[0].message.content,CASES.chatgpt.want);
  assert.equal(networkCalls,1);
});
