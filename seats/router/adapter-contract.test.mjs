import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCouncilApplication, runCouncilWorkflow } from "./durable-core.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROUTER = "https://council-contract.test";
const KEY = "synthetic-test-router-key";
const PY_FIXTURE = String.raw`import datetime as dt
import hashlib
import json
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "scripts"))
import seat_adapter as sa
import council_check as cc

temp = tempfile.TemporaryDirectory()
root = Path(temp.name)
thread = "contractcase"
seat = "chatgpt"
tdir = root / "council" / "threads" / thread
tdir.mkdir(parents=True)
incoming = cc.seal({
    "schema": cc.SCHEMA_ID,
    "thread": thread,
    "seq": 0,
    "from": "founder",
    "to": seat,
    "createdAt": "2026-11-24T15:00:00Z",
    "phaseSeam": "DECLARE",
    "state": {"immutableFingerprint": {
        "repo": "jussray/Council-Bus", "branch": "main", "head": "a" * 40}},
    "claims": [{"label": "UNKNOWN", "text": "Synthetic contract check"}],
    "authority": {"decisionOwner": "founder", "grantsExecutionAuthority": False},
    "body": "Respond only in the test's synthetic provider mock.",
    "attachments": [],
    "prevHash": cc.GENESIS,
})
(tdir / "0000-founder-chatgpt.json").write_text(json.dumps(incoming))
idempotency, expected_id = sa._workflow_identity(thread, seat, incoming)
`;

function pythonRun(code, input) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: ROOT, input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test("Python ledger adapter interoperates with real JS intake, queue, approval gate and sanitized collection", async () => {
  const submission = pythonRun(PY_FIXTURE + String.raw`
captured = {}
def submit(url, headers, payload):
    captured.update({"url": url, "headers": headers, "body": json.loads(payload)})
    return 202, json.dumps({
        "id": expected_id, "state": "queued_for_approval", "approved": False
    }).encode()
before = len(list(tdir.glob("*.json")))
actual = sa.enqueue(root, thread, seat, "${ROUTER}", "${KEY}", transport=submit)
assert actual == expected_id
assert len(list(tdir.glob("*.json"))) == before
print(json.dumps({"id": actual, "idempotency": idempotency, "request": captured}))
`);
  assert.equal(submission.request.headers["idempotency-key"], submission.idempotency);
  assert.equal(submission.request.headers["x-council-seat"], "chatgpt");

  const queued = [], created = [], events = [];
  const env = {
    ROUTER_API_KEY_CHATGPT: KEY,
    COUNCIL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    COUNCIL_INTAKE: { send: async (job) => queued.push(job) },
    COUNCIL_DURABLE: {
      create: async (value) => { created.push(value); return { id: value.id }; },
      get: async () => ({
        status: async () => ({ status: "running" }),
        sendEvent: async (event) => events.push(event),
      }),
    },
  };
  const app = createCouncilApplication({
    router: { fetch: async () => { throw new Error("paid provider must never run in contract test"); } },
  });
  const post = (url, body, token = KEY, extra = {}) => new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "x-council-seat": "chatgpt",
      "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
  const intake = await app.fetch(post(submission.request.url,
    submission.request.body, KEY,
    { "idempotency-key": submission.request.headers["idempotency-key"] }), env);
  assert.equal(intake.status, 202);
  const receipt = await intake.json();
  assert.equal(receipt.id, submission.id, "Python-derived immutable id must match live JS contract");
  assert.equal(receipt.approved, false);
  assert.equal(queued.length, 1);
  assert.equal(events.length, 0);

  let ack = 0, retry = 0;
  await app.queue({ messages: [{ body: queued[0], ack: () => ack++, retry: () => retry++ }] }, env);
  assert.equal(ack, 1);
  assert.equal(retry, 0);
  assert.equal(created[0].id, submission.id);
  const target = ROUTER + "/v1/council/workflows/" + submission.id;
  const get = (token = KEY) => new Request(target, {
    headers: { authorization: "Bearer " + token, "x-council-seat": "chatgpt" },
  });
  assert.equal((await app.fetch(get("wrong"), env)).status, 401);
  assert.equal((await app.fetch(get(), env)).status, 200);
  assert.equal((await app.fetch(post(target + "/approve", { decision: "approve" }, "wrong"), env)).status, 401);
  assert.equal(events.length, 0);
  assert.equal((await app.fetch(post(target + "/approve", { decision: "deny" }), env)).status, 400);
  assert.equal(events.length, 0);
  assert.equal((await app.fetch(post(target + "/approve", { decision: "approve" }), env)).status, 202);
  assert.equal(events.length, 1);

  let fakeProviderCalls = 0;
  const step = {
    do: async (_name, opts, fn) => (typeof opts === "function" ? opts() : fn()),
    waitForEvent: async () => events[0],
  };
  const output = await runCouncilWorkflow({
    instanceId: submission.id,
    payload: { seat: "chatgpt", messages: queued[0].messages },
  }, step, env, { router: { fetch: async () => {
    fakeProviderCalls++;
    return Response.json({
      id: "resp_synthetic_contract", seat: "chatgpt",
      choices: [{ message: { content: "[INFERRED] Synthetic test result." } }],
      provider: { name: "openai", raw: "PRIVATE_RAW_SHOULD_NOT_PERSIST" },
    });
  } } });
  assert.equal(fakeProviderCalls, 1);
  assert.equal(output.state, "completed");

  const ledger = pythonRun(PY_FIXTURE + String.raw`
status = json.loads(sys.stdin.read())
assert status["id"] == expected_id
value = {"id": expected_id, "status": "complete", "output": status["output"]}
def get_status(url, headers):
    assert url.endswith("/" + expected_id)
    return 200, json.dumps(value).encode()
written = sa.collect(root, thread, seat, "${ROUTER}", "${KEY}", expected_id,
                     transport=get_status, now=dt.datetime(2026, 11, 24, 16, tzinfo=dt.timezone.utc))
assert written is not None
assert cc.run(root).code == cc.OK
message = json.loads(written.read_text())
attachment = tdir / "attachments" / message["attachments"][0]["path"]
saved = json.loads(attachment.read_text())
print(json.dumps({
    "body": message["body"],
    "approved_automatically": message["authority"]["grantsExecutionAuthority"],
    "receipt_keys": sorted(saved.keys()),
    "receipt_text": attachment.read_text(),
}))
`, { id: submission.id, output: { ...output, provider_raw: "PRIVATE_RAW_SHOULD_NOT_PERSIST" } });
  assert.equal(ledger.body, "[INFERRED] Synthetic test result.");
  assert.equal(ledger.approved_automatically, false);
  assert.deepEqual(ledger.receipt_keys,
    ["content", "instance_id", "provider", "response_id", "seat", "state"]);
  assert.doesNotMatch(ledger.receipt_text, /PRIVATE_RAW|provider_raw|Bearer/);
});
