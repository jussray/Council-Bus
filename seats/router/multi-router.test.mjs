import { test } from "node:test";
import assert from "node:assert/strict";
import { createCouncilRouter } from "./multi-router.js";

const SEATS = {
  chatgpt: { key: "openai-key", model: "gpt-6", endpoint: "https://api.openai.com/v1/responses" },
  claude: { key: "anthropic-key", model: "claude-test", endpoint: "https://api.anthropic.com/v1/messages" },
  deepseek: { key: "deepseek-key", model: "deepseek-flash", endpoint: "https://api.deepseek.com/responses" },
  muse: { key: "muse-key", model: "muse-spark-1.2", endpoint: "https://api.meta.ai/v1/responses" },
  perplexity: { key: "perplexity-key", model: "sonar", endpoint: "https://api.perplexity.ai/v1/agent" },
};

function environment() {
  const env = { ROUTER_API_KEY: "not-a-global-bypass", SEAT: "claude", SEAT_MODEL: "wrong-global" };
  const name = { chatgpt: "OPENAI", claude: "ANTHROPIC", deepseek: "DEEPSEEK", muse: "MUSE", perplexity: "PERPLEXITY" };
  for (const [seat, config] of Object.entries(SEATS)) {
    const suffix = seat.toUpperCase();
    env["ROUTER_API_KEY_" + suffix] = "token-" + seat;
    env["SEAT_MODEL_" + suffix] = config.model;
    env[name[seat] + "_API_KEY"] = config.key;
  }
  return env;
}

function request(seat, token, body = {model: "caller-overridden", messages: [{role: "user", content: "ping"}]}, path = "/v1/chat/completions") {
  const headers = {"content-type": "application/json", authorization: "Bearer " + token};
  if (seat !== null) headers["x-council-seat"] = seat;
  return new Request("https://council.example" + path, {method: "POST", headers, body: JSON.stringify(body)});
}

function reply(seat) {
  if (seat === "claude") return {id: "m_1", type: "message", role: "assistant", content: [{type: "text", text: "ok"}]};
  return {id: "r_1", status: "completed", output: [{type: "message", content: [{type: "output_text", text: "ok"}]}]};
}

test("one Worker routes all five seats, using only the selected provider and configured model", async () => {
  const calls = [];
  const worker = createCouncilRouter({fetchImpl: async (url, init) => {
    calls.push({url, init});
    const seat = Object.keys(SEATS).find(k => SEATS[k].endpoint === url);
    return new Response(JSON.stringify(reply(seat)), {status: 200});
  }});
  for (const [seat, entry] of Object.entries(SEATS)) {
    const res = await worker.fetch(request(seat, "token-" + seat), environment());
    assert.equal(res.status, 200, seat);
    const body = await res.json();
    assert.equal(body.seat, seat);
    assert.equal(body.choices[0].message.content, "ok");
    const {url, init} = calls.at(-1);
    assert.equal(url, entry.endpoint);
    assert.equal(JSON.parse(init.body).model, seat === "perplexity" ? "perplexity/sonar" : entry.model);
    const header = seat === "claude" ? init.headers["x-api-key"] : init.headers.authorization;
    assert.equal(header, seat === "claude" ? entry.key : "Bearer " + entry.key);
  }
  assert.equal(calls.length, 5);
});

test("each seat has its own router token; another seat's token and global token cannot authenticate", async () => {
  const calls = [];
  const worker = createCouncilRouter({fetchImpl: (...args) => { calls.push(args); throw new Error("should not fetch"); }});
  const env = environment();
  assert.equal((await worker.fetch(request("claude", "token-chatgpt"), env)).status, 401);
  assert.equal((await worker.fetch(request("claude", "not-a-global-bypass"), env)).status, 401);
  assert.equal((await worker.fetch(request("claude", ""), env)).status, 401);
  delete env.ROUTER_API_KEY_CLAUDE;
  assert.equal((await worker.fetch(request("claude", "token-claude"), env)).status, 503);
  assert.equal(calls.length, 0);
});

test("no seat fallback, no prototype keys, and no caller-chosen model", async () => {
  const calls = [];
  const worker = createCouncilRouter({fetchImpl: (...args) => { calls.push(args); throw new Error("should not fetch"); }});
  for (const seat of [null, "", "unknown", "__proto__", "constructor", "CLAUDE"]) {
    const res = await worker.fetch(request(seat, "token-claude"), environment());
    assert.equal(res.status, 400, String(seat));
  }
  const env = environment();
  env.SEAT_MODEL_CLAUDE = "INVALID MODEL!";
  assert.equal((await worker.fetch(request("claude", "token-claude"), env)).status, 503);
  assert.equal(calls.length, 0);
});

test("health exposes no keys or provider readiness and other paths are rejected", async () => {
  const worker = createCouncilRouter({fetchImpl: async () => {throw new Error("unexpected upstream");}});
  const env = environment();
  const health = await worker.fetch(new Request("https://council.example/health"), env);
  assert.equal(health.status, 200);
  const text = await health.text();
  assert.ok(!text.includes("token-"));
  assert.ok(!text.includes("anthropic-key"));
  assert.equal((await worker.fetch(request("chatgpt", "token-chatgpt", {}, "/other"), env)).status, 404);
});
