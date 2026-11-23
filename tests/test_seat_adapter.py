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


if __name__ == "__main__":
    unittest.main()
