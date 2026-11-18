import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import council_check as cc  # noqa: E402

HEAD = "a" * 40


def make(seq, frm, to, prev, attachments=None, body="hello"):
    return cc.seal({
        "schema": cc.SCHEMA_ID, "thread": "t1", "seq": seq, "from": frm, "to": to,
        "createdAt": "2026-11-17T21:00:00Z", "phaseSeam": "DECLARE",
        "state": {"immutableFingerprint": {"repo": "JussAndCo/council-bus", "branch": "main", "head": HEAD}},
        "claims": [{"label": "VERIFIED", "text": "example claim"}],
        "authority": {"decisionOwner": "founder", "grantsExecutionAuthority": False},
        "body": body, "attachments": attachments or [], "prevHash": prev,
    })


class Bus(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.t = self.root / "council" / "threads" / "t1"
        (self.t / "attachments").mkdir(parents=True)
        (self.t / "attachments" / "a.txt").write_bytes(b"evidence")
        att = [{"path": "a.txt", "sha256": hashlib.sha256(b"evidence").hexdigest()}]
        self.m0 = make(0, "claude", "chatgpt", cc.GENESIS, att)
        self.m1 = make(1, "chatgpt", "claude", self.m0["proofCookie"])
        self.write(self.m0)
        self.write(self.m1)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, m):
        p = self.t / f"{m['seq']:04d}-{m['from']}-{m['to']}.json"
        p.write_text(json.dumps(m, indent=2))
        return p

    def code(self, **kw):
        return cc.run(self.root, **kw).code

    def test_valid_chain_ok(self):
        self.assertEqual(self.code(), cc.OK)
        self.assertEqual(self.code(head=HEAD), cc.OK)

    def test_tampered_body_broken(self):
        m = copy.deepcopy(self.m1); m["body"] = "changed"; self.write(m)
        self.assertEqual(self.code(), cc.BROKEN)

    def test_tampered_attachment_broken(self):
        (self.t / "attachments" / "a.txt").write_bytes(b"forged")
        self.assertEqual(self.code(), cc.BROKEN)

    def test_missing_attachment_unverified(self):
        (self.t / "attachments" / "a.txt").unlink()
        self.assertEqual(self.code(), cc.UNVERIFIED)

    def test_chain_gap_broken(self):
        (self.t / "0001-chatgpt-claude.json").unlink()
        self.write(make(2, "chatgpt", "claude", self.m0["proofCookie"]))
        self.assertEqual(self.code(), cc.BROKEN)

    def test_wrong_prev_broken(self):
        self.write(make(1, "chatgpt", "claude", cc.GENESIS))
        self.assertEqual(self.code(), cc.BROKEN)

    def test_credential_broken(self):
        self.write(make(1, "chatgpt", "claude", self.m0["proofCookie"], body="ghp_" + "x" * 36))
        self.assertEqual(self.code(), cc.BROKEN)

    def test_authority_grant_broken(self):
        m = copy.deepcopy(self.m1); m["authority"]["grantsExecutionAuthority"] = True
        self.write(cc.seal(m))
        self.assertEqual(self.code(), cc.BROKEN)

    def test_unlabelled_claim_broken(self):
        m = copy.deepcopy(self.m1); m["claims"] = [{"label": "TRUE", "text": "x"}]
        self.write(cc.seal(m))
        self.assertEqual(self.code(), cc.BROKEN)

    def test_wrong_head_stale(self):
        self.assertEqual(self.code(head="b" * 40), cc.STALE)

    def test_attachment_escape_broken(self):
        (self.t / "0001-chatgpt-claude.json").unlink()
        self.write(make(1, "chatgpt", "claude", self.m0["proofCookie"],
                        [{"path": "../../../README", "sha256": "0" * 64}]))
        self.assertEqual(self.code(), cc.BROKEN)

    def test_node_hash_equals_python(self):
        js = ("const m=JSON.parse(require('fs').readFileSync(0,'utf8'));delete m.bodyHash;delete m.proofCookie;"
              "const s=v=>Array.isArray(v)?v.map(s):v&&typeof v==='object'?Object.keys(v).sort().reduce((o,k)=>(o[k]=s(v[k]),o),{}):v;"
              "process.stdout.write(require('crypto').createHash('sha256').update(JSON.stringify(s(m))).digest('hex'))")
        out = subprocess.run(["node", "-e", js], input=json.dumps(self.m0), capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout, self.m0["bodyHash"])


class SingleWriter(unittest.TestCase):
    def test_other_member_on_branch_broken(self):
        with tempfile.TemporaryDirectory() as d:
            g = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True)
            g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
            (Path(d) / "README.md").write_text("x"); g("add", "."); g("commit", "-qm", "base")
            g("checkout", "-qb", "council/claude/t1")
            t = Path(d) / "council" / "threads" / "t1"; t.mkdir(parents=True)
            m = make(0, "muse", "claude", cc.GENESIS)
            (t / "0000-muse-claude.json").write_text(json.dumps(m)); g("add", "."); g("commit", "-qm", "m")
            import os
            cwd = os.getcwd(); os.chdir(d)
            try:
                rep = cc.run(d, branch="council/claude/t1", base="main")
            finally:
                os.chdir(cwd)
            self.assertEqual(rep.code, cc.BROKEN)
            self.assertTrue(any("single-writer" in l for l in rep.lines))


if __name__ == "__main__":
    unittest.main()
