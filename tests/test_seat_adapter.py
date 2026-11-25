import datetime as dt
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import council_check as cc  # noqa: E402
import seat_adapter as sa  # noqa: E402

HEAD = "b" * 40
URL = "https://router.example"
NOW = dt.datetime(2026, 11, 22, 12, 0, tzinfo=dt.timezone.utc)


def make(seq, frm, to, prev, body="Perplexity: is X true?"):
    return cc.seal({
        "schema": cc.SCHEMA_ID, "thread": "t1", "seq": seq, "from": frm, "to": to,
        "createdAt": "2026-11-22T11:00:00Z", "phaseSeam": "DECLARE",
        "state": {"immutableFingerprint": {"repo": "jussray/council-bus", "branch": "main", "head": HEAD}},
        "claims": [{"label": "UNKNOWN", "text": "needs research"}],
        "authority": {"decisionOwner": "founder", "grantsExecutionAuthority": False},
        "body": body, "attachments": [], "prevHash": prev,
    })


def completion(content="[INFERRED] X looks true.", **extra):
    return json.dumps({"id": "cmpl-1", "model": "sonar", "choices": [
        {"index": 0, "message": {"role": "assistant", "content": content}}], **extra}).encode()


class Transport:
    def __init__(self, status=200, raw=None):
        self.status, self.raw, self.calls = status, raw if raw is not None else completion(), []

    def __call__(self, url, headers, payload):
        self.calls.append((url, headers, json.loads(payload)))
        return self.status, self.raw


class Adapter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.t = self.root / "council" / "threads" / "t1"
        self.t.mkdir(parents=True)
        self.m0 = make(0, "claude", "perplexity", cc.GENESIS)
        self.put(self.m0)

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, msg):
        (self.t / f"{msg['seq']:04d}-{msg['from']}-{msg['to']}.json").write_text(json.dumps(msg))

    def answer(self, transport, key="k", **kw):
        return sa.answer(self.root, "t1", "perplexity", URL, key, transport=transport, now=NOW, **kw)

    def files(self):
        return sorted(str(p.relative_to(self.t)) for p in self.t.rglob("*") if p.is_file())

    def test_happy_path_writes_sealed_reply_and_bound_raw_response(self):
        tr = Transport()
        out = self.answer(tr, model="sonar")
        self.assertEqual(out.name, "0001-perplexity-claude.json")
        msg = json.loads(out.read_text())
        self.assertEqual((msg["seq"], msg["from"], msg["to"], msg["phaseSeam"]), (1, "perplexity", "claude", "RECORD"))
        self.assertEqual(msg["prevHash"], self.m0["proofCookie"])
        self.assertEqual(msg["body"], "[INFERRED] X looks true.")
        self.assertEqual(msg["authority"], {"decisionOwner": "founder", "grantsExecutionAuthority": False})
        self.assertEqual(msg["state"], self.m0["state"])
        raw = (self.t / "attachments" / msg["attachments"][0]["path"]).read_bytes()
        self.assertEqual(raw, tr.raw)
        self.assertEqual(msg["attachments"][0]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual([c["label"] for c in msg["claims"]], ["VERIFIED", "INFERRED"])
        self.assertEqual(cc.run(self.root).code, cc.OK)
        url, headers, body = tr.calls[0]
        self.assertEqual(url, URL + "/v1/chat/completions")
        self.assertEqual(headers["authorization"], "Bearer k")
        self.assertEqual(headers["x-council-seat"], "perplexity")
        self.assertEqual(body["model"], "sonar")
        self.assertIn("Perplexity: is X true?", body["messages"][1]["content"])

    def test_tampered_attachment_is_caught_by_checker(self):
        out = self.answer(Transport())
        att = self.t / "attachments" / json.loads(out.read_text())["attachments"][0]["path"]
        att.write_bytes(completion("[VERIFIED] forged"))
        self.assertEqual(cc.run(self.root).code, cc.BROKEN)

    def test_noop_when_latest_not_addressed_to_seat(self):
        self.put(make(1, "perplexity", "claude", self.m0["proofCookie"]))
        tr = Transport()
        self.assertIsNone(self.answer(tr))
        self.assertEqual(tr.calls, [])

    def test_noop_on_empty_thread(self):
        (self.t / "0000-claude-perplexity.json").unlink()
        self.assertIsNone(self.answer(Transport()))

    def assertRefusedClean(self, transport, key="k", url=URL):
        before = self.files()
        with self.assertRaises(sa.Refused):
            sa.answer(self.root, "t1", "perplexity", url, key, transport=transport, now=NOW)
        self.assertEqual(self.files(), before)

    def test_refuses_without_key(self):
        tr = Transport()
        self.assertRefusedClean(tr, key="")
        self.assertEqual(tr.calls, [])

    def test_refuses_plain_http(self):
        self.assertRefusedClean(Transport(), url="http://router.example")

    def test_refuses_router_errors(self):
        for status in (401, 429, 502, 503):
            self.assertRefusedClean(Transport(status=status, raw=b'{"error":{"message":"x"}}'))
            # A completion-shaped body must not slip past a non-200 status.
            self.assertRefusedClean(Transport(status=status, raw=completion()))

    def test_refuses_malformed_or_empty_reply(self):
        for raw in (b"not json", b"{}", b'{"choices":[]}', completion(""), completion("   "),
                    completion("x" * (sa.MAX_REPLY_CHARS + 1))):
            self.assertRefusedClean(Transport(raw=raw))

    def test_refuses_credential_shaped_reply(self):
        self.assertRefusedClean(Transport(raw=completion("key: sk-" + "a" * 30)))
        self.assertRefusedClean(Transport(raw=completion("ok", leak="ghp_" + "a" * 36)))

    def test_refuses_when_thread_already_broken(self):
        bad = dict(self.m0, body="tampered")
        self.put(bad)
        self.assertRefusedClean(Transport())

    def test_refuses_to_overwrite(self):
        self.answer(Transport())
        # Reset latest to address the seat again at the same seq slot.
        (self.t / "0001-perplexity-claude.json").rename(self.root / "moved.json")
        self.assertTrue((self.t / "attachments" / "0001-perplexity-claude.router-response.json").exists())
        with self.assertRaises(sa.Refused):
            self.answer(Transport())

    def seat_router_envelope(self, seat, content, raw_provider):
        # Same shape seats/router/seat-router.js returns for every seat.
        return json.dumps({
            "id": "resp_1", "object": "chat.completion", "model": "m", "seat": seat,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "provider": {"name": "p", "endpoint": "https://api.example/v1", "status": 200, "raw": raw_provider},
        }).encode()

    def test_every_seat_router_envelope_is_recorded(self):
        for seat in ("claude", "chatgpt", "deepseek", "muse", "perplexity"):
            with self.subTest(seat=seat):
                for p in sorted(self.t.rglob("*"), reverse=True):
                    p.unlink() if p.is_file() else p.rmdir()
                self.t.mkdir(parents=True, exist_ok=True)
                m0 = make(0, "founder", seat, cc.GENESIS)
                self.put(m0)
                raw = self.seat_router_envelope(seat, f"{seat} reply", '{"id":"resp_1","status":"completed"}')
                out = sa.answer(self.root, "t1", seat, URL, "k", transport=Transport(raw=raw), now=NOW)
                self.assertEqual(out.name, f"0001-{seat}-founder.json")
                msg = json.loads(out.read_text())
                self.assertEqual(msg["body"], f"{seat} reply")
                self.assertEqual((self.t / "attachments" / msg["attachments"][0]["path"]).read_bytes(), raw)
                self.assertEqual(cc.run(self.root).code, cc.OK)

    def test_secret_inside_provider_raw_is_refused(self):
        raw = self.seat_router_envelope("perplexity", "clean reply", '{"leak":"sk-' + "a" * 30 + '"}')
        self.assertRefusedClean(Transport(raw=raw))

    def test_cli_exit_codes(self):
        self.assertEqual(sa.main(["--root", str(self.root), "--thread", "t1",
                                  "--router-url", "http://router.example"]), 2)


    def workflow_id(self, seat="perplexity"):
        key = hashlib.sha256(f"t1:{seat}:{self.m0['proofCookie']}".encode()).hexdigest()
        return f"council-{seat}-" + hashlib.sha256(f"{seat}:{key}".encode()).hexdigest()[:32]

    def test_durable_enqueue_is_deterministic_and_does_not_write_or_approve(self):
        workflow_id = self.workflow_id()
        tr = Transport(status=202, raw=json.dumps({
            "id": workflow_id, "state": "queued_for_approval", "approved": False,
        }).encode())
        before = self.files()
        actual = sa.enqueue(self.root, "t1", "perplexity", URL, "k",
                            transport=tr)
        self.assertEqual(actual, workflow_id)
        self.assertEqual(before, self.files())
        self.assertEqual(len(tr.calls), 1)
        url, headers, payload = tr.calls[0]
        self.assertEqual(url, URL + "/v1/council/workflows")
        self.assertEqual(headers["x-council-seat"], "perplexity")
        self.assertEqual(headers["authorization"], "Bearer k")
        self.assertEqual(len(headers["idempotency-key"]), 64)
        self.assertNotIn("model", payload)
        self.assertIn("Perplexity: is X true?", payload["messages"][1]["content"])
        self.assertFalse(any("approve" in url for url, _, _ in tr.calls))

    def test_durable_enqueue_fails_closed_on_wrong_id_and_status(self):
        before = self.files()
        for status, data in (
            (409, {"error": {"message": "legacy endpoint"}}),
            (202, {"id": "council-perplexity-" + "f" * 32, "state": "queued_for_approval", "approved": False}),
            (202, {"id": self.workflow_id(), "state": "completed", "approved": True}),
        ):
            with self.subTest(status=status, data=data):
                tr = Transport(status=status, raw=json.dumps(data).encode())
                with self.assertRaises(sa.Refused):
                    sa.enqueue(self.root, "t1", "perplexity", URL, "k", transport=tr)
                self.assertEqual(self.files(), before)

    def test_durable_collect_only_records_proven_completed_workflow(self):
        workflow_id = self.workflow_id()
        body = {
            "id": workflow_id,
            "status": "complete",
            "output": {
                "state": "completed", "seat": "perplexity",
                "provider": "perplexity", "response_id": "resp_example_1",
                "content": "[INFERRED] The claim remains unresolved.",
                "provider_raw": "do-not-persist-private-provider-body",
            },
            "debug": "not-a-public-attachment",
        }
        calls = []
        def getter(url, headers):
            calls.append((url, dict(headers)))
            return 200, json.dumps(body).encode()

        out = sa.collect(self.root, "t1", "perplexity", URL, "k", workflow_id,
                         transport=getter, now=NOW)
        self.assertEqual(out.name, "0001-perplexity-claude.json")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], URL + "/v1/council/workflows/" + workflow_id)
        self.assertEqual(calls[0][1]["x-council-seat"], "perplexity")
        msg = json.loads(out.read_text())
        self.assertEqual(msg["prevHash"], self.m0["proofCookie"])
        self.assertEqual(msg["authority"], {"decisionOwner": "founder", "grantsExecutionAuthority": False})
        self.assertEqual(msg["body"], "[INFERRED] The claim remains unresolved.")
        self.assertEqual([c["label"] for c in msg["claims"]], ["VERIFIED", "INFERRED"])
        attachment = (self.t / "attachments" / msg["attachments"][0]["path"]).read_bytes()
        self.assertEqual(msg["attachments"][0]["sha256"], hashlib.sha256(attachment).hexdigest())
        self.assertNotIn(b"provider_raw", attachment)
        self.assertNotIn(b"debug", attachment)
        self.assertIn(b"resp_example_1", attachment)
        self.assertEqual(cc.run(self.root).code, cc.OK)

    def test_durable_collect_refuses_unapproved_unrelated_failed_or_secret(self):
        workflow_id = self.workflow_id()
        prior = self.files()
        invalid_cases = [
            {"id": workflow_id, "status": "running", "output": None},
            {"id": workflow_id, "status": "complete", "output": {"state": "blocked", "seat": "perplexity"}},
            {"id": workflow_id, "status": "complete", "output": {
                "state": "completed", "seat": "chatgpt", "provider": "openai",
                "response_id": "resp_test", "content": "wrong seat",
            }},
            {"id": workflow_id, "status": "complete", "output": {
                "state": "completed", "seat": "perplexity", "provider": "perplexity",
                "response_id": "resp_test", "content": "sk-" + "a" * 40,
            }},
        ]
        for value in invalid_cases:
            with self.subTest(value=value):
                with self.assertRaises(sa.Refused):
                    sa.collect(self.root, "t1", "perplexity", URL, "k", workflow_id,
                               transport=lambda url, headers: (200, json.dumps(value).encode()), now=NOW)
                self.assertEqual(self.files(), prior)

        wrong_id = "council-perplexity-" + "f" * 32
        with self.assertRaises(sa.Refused):
            sa.collect(self.root, "t1", "perplexity", URL, "k", wrong_id,
                       transport=lambda url, headers: self.fail("should not make request"))
        self.assertEqual(self.files(), prior)

    def test_durable_collect_refuses_replay_after_message_written(self):
        workflow_id = self.workflow_id()
        value = {"id": workflow_id, "status": "complete", "output": {
            "state": "completed", "seat": "perplexity", "provider": "perplexity",
            "response_id": "resp_test", "content": "ready",
        }}
        get = lambda url, headers: (200, json.dumps(value).encode())
        out = sa.collect(self.root, "t1", "perplexity", URL, "k", workflow_id,
                         transport=get, now=NOW)
        files = self.files()
        self.assertTrue(out.is_file())
        self.assertIsNone(sa.collect(self.root, "t1", "perplexity", URL, "k", workflow_id,
                                     transport=lambda url, headers: self.fail("no second retrieval"), now=NOW))
        self.assertEqual(self.files(), files)


if __name__ == "__main__":
    unittest.main()
