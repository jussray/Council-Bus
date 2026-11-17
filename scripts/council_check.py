#!/usr/bin/env python3
"""Council Bus checker for juss/council-message@v1 (stdlib only).

Exit codes: 0 OK, 1 STALE, 2 BROKEN, 3 UNVERIFIED.
The worst finding wins (BROKEN > UNVERIFIED > STALE > OK).

A message never grants execution authority. This checker verifies integrity
(hash chain, attachments, secrets, single-writer branch); it never approves.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

SCHEMA_ID = "juss/council-message@v1"
GENESIS = "0" * 64
OK, STALE, BROKEN, UNVERIFIED = 0, 1, 2, 3
RANK = {OK: 0, STALE: 1, UNVERIFIED: 2, BROKEN: 3}
NAMES = {OK: "OK", STALE: "STALE", BROKEN: "BROKEN", UNVERIFIED: "UNVERIFIED"}
LABELS = {"VERIFIED", "INFERRED", "UNKNOWN", "BLOCKED", "FAIL"}
FILE_RE = re.compile(r"^(\d{4})-([a-z0-9]+)-([a-z0-9]+)\.json$")
BRANCH_RE = re.compile(r"^council/([a-z0-9]+)/([a-z0-9][a-z0-9-]*)$")
SECRET_RES = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{30,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
REQUIRED = ["schema", "thread", "seq", "from", "to", "createdAt", "phaseSeam",
            "state", "claims", "authority", "body", "attachments",
            "prevHash", "bodyHash", "proofCookie"]


def canonical(value):
    """Sorted-key compact JSON; equals JS JSON.stringify of a key-sorted copy."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def body_hash(msg):
    core = {k: v for k, v in msg.items() if k not in ("bodyHash", "proofCookie")}
    return sha256_text(canonical(core))


def proof_cookie(prev_hash, bhash):
    # Non-secret evidence-lineage marker. Never a credential or approval token.
    return sha256_text(f"council-cookie:v1|{prev_hash}|{bhash}")


def seal(msg):
    msg = dict(msg)
    msg.pop("bodyHash", None)
    msg.pop("proofCookie", None)
    msg["bodyHash"] = body_hash(msg)
    msg["proofCookie"] = proof_cookie(msg["prevHash"], msg["bodyHash"])
    return msg


class Report:
    def __init__(self):
        self.code = OK
        self.lines = []

    def add(self, code, where, text):
        if RANK[code] > RANK[self.code]:
            self.code = code
        self.lines.append(f"{NAMES[code]}: {where}: {text}")


def check_message(path, msg, rep, expected_seq, expected_prev, thread):
    where = str(path)
    missing = [k for k in REQUIRED if k not in msg]
    if missing:
        rep.add(BROKEN, where, f"missing fields {missing}")
        return None
    m = FILE_RE.match(path.name)
    if not m:
        rep.add(BROKEN, where, "file name must be NNNN-<from>-<to>.json")
        return None
    if msg["schema"] != SCHEMA_ID:
        rep.add(BROKEN, where, f"schema must be {SCHEMA_ID}")
    if msg["thread"] != thread:
        rep.add(BROKEN, where, f"thread {msg['thread']!r} != folder {thread!r}")
    if int(m.group(1)) != msg["seq"] or m.group(2) != msg["from"] or m.group(3) != msg["to"]:
        rep.add(BROKEN, where, "file name does not match seq/from/to")
    if msg["seq"] != expected_seq:
        rep.add(BROKEN, where, f"chain gap: expected seq {expected_seq}, got {msg['seq']}")
    auth = msg["authority"]
    if not isinstance(auth, dict) or auth.get("decisionOwner") != "founder" \
            or auth.get("grantsExecutionAuthority") is not False:
        rep.add(BROKEN, where, "authority must be {decisionOwner: founder, grantsExecutionAuthority: false}")
    for c in msg["claims"] if isinstance(msg["claims"], list) else [None]:
        if not isinstance(c, dict) or c.get("label") not in LABELS or not c.get("text"):
            rep.add(BROKEN, where, f"every claim needs label in {sorted(LABELS)} and text")
            break
    if msg["prevHash"] != expected_prev:
        rep.add(BROKEN, where, "prevHash does not equal previous proofCookie")
    if msg["bodyHash"] != body_hash(msg):
        rep.add(BROKEN, where, "bodyHash mismatch (message tampered)")
    if msg["proofCookie"] != proof_cookie(msg["prevHash"], msg["bodyHash"]):
        rep.add(BROKEN, where, "proofCookie mismatch")
    raw = path.read_text(encoding="utf-8")
    for rx in SECRET_RES:
        if rx.search(raw):
            rep.add(BROKEN, where, "credential-like string present; secrets never enter the ledger")
            break
    for att in msg["attachments"]:
        ap = (path.parent / "attachments" / att.get("path", "")).resolve()
        if path.parent.resolve() not in ap.parents:
            rep.add(BROKEN, where, f"attachment path escapes thread: {att.get('path')}")
            continue
        if not ap.is_file():
            rep.add(UNVERIFIED, where, f"attachment missing: {att.get('path')}")
            continue
        if hashlib.sha256(ap.read_bytes()).hexdigest() != att.get("sha256"):
            rep.add(BROKEN, where, f"attachment hash mismatch: {att.get('path')}")
    return msg["proofCookie"]


def added_files(base):
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=AM", f"{base}...HEAD"],
                         capture_output=True, text=True, check=True).stdout
    return {Path(p) for p in out.split() if p}


def run(root, head=None, branch=None, base=None):
    rep = Report()
    threads_dir = Path(root) / "council" / "threads"
    latest = {}
    for tdir in sorted(p for p in threads_dir.glob("*") if p.is_dir()) if threads_dir.is_dir() else []:
        prev, seq = GENESIS, 0
        for path in sorted(tdir.glob("*.json")):
            try:
                msg = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError) as exc:
                rep.add(BROKEN, str(path), f"unreadable JSON: {exc}")
                prev = None
                break
            prev = check_message(path, msg, rep, seq, prev, tdir.name)
            seq += 1
            latest[tdir.name] = msg
            if prev is None:
                break
    if head:
        for name, msg in latest.items():
            if msg["state"].get("immutableFingerprint", {}).get("head") != head:
                rep.add(STALE, name, "latest message is bound to a different head; present-tense claims expired")
    if branch:
        bm = BRANCH_RE.match(branch)
        if not bm:
            rep.add(BROKEN, branch, "writer branch must be council/<member>/<thread>")
        elif base:
            member, thread = bm.groups()
            for p in added_files(base):
                parts = p.parts
                if parts[:2] != ("council", "threads") or p.suffix != ".json" or "attachments" in parts:
                    continue
                fm = FILE_RE.match(p.name)
                if parts[2] != thread or not fm or fm.group(2) != member:
                    rep.add(BROKEN, str(p), f"single-writer violation: branch {branch} may only add {member}'s messages in {thread}")
    if not rep.lines:
        rep.lines.append("OK: no findings")
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--head", help="expected repo head SHA bound in latest messages")
    ap.add_argument("--branch", help="writer branch council/<member>/<thread>")
    ap.add_argument("--base", help="git base ref for the single-writer check")
    args = ap.parse_args(argv)
    rep = run(args.root, args.head, args.branch, args.base)
    print("\n".join(rep.lines))
    print(f"RESULT: {NAMES[rep.code]}")
    return rep.code


if __name__ == "__main__":
    sys.exit(main())
