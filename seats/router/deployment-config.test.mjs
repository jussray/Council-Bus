import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The production Cloudflare Worker holds secrets and binding configuration
// outside Git. A routine Wrangler deployment must not erase dashboard vars.
const config = readFileSync(new URL("./wrangler.council.jsonc", import.meta.url), "utf8");

test("Council production deploy preserves existing dashboard variables", () => {
  assert.match(config, /"keep_vars"\s*:\s*true\s*[,}]/,
    "Wrangler must set keep_vars=true to retain dashboard-managed variables");
});

test("Council production retains its existing Workflow, Queue, limiter and no-provider-fallback defaults", () => {
  for (const binding of [
    "COUNCIL_DURABLE", "COUNCIL_INTAKE", "COUNCIL_RATE_LIMITER",
    "SEAT_MODEL_CHATGPT", "SEAT_MODEL_CLAUDE", "SEAT_MODEL_DEEPSEEK",
    "SEAT_MODEL_MUSE", "SEAT_MODEL_PERPLEXITY",
  ]) {
    assert.ok(config.includes('"' + binding + '"'), "missing expected binding " + binding);
  }
  assert.match(config, /"main"\s*:\s*"workflow-entry\.js"/);
  assert.match(config, /"logpush"\s*:\s*true/);
});
