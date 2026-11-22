#!/usr/bin/env python3
"""Seat adapter: answer a bus message addressed to an API-only seat (stdlib only).

Reads the latest message of one thread. If it is addressed to the seat
(default: perplexity), sends it through the seat router, then writes the reply
as the next sealed message plus the raw router response as an attachment bound
by sha256. Anyone can re-hash the attachment and see exactly what the API said.

Fail-closed: on any router error, malformed reply, credential-shaped text or a
broken resulting chain, nothing is written.

The adapter records. It never approves: the reply carries
authority {decisionOwner: founder, grantsExecutionAuthority: false} like every
message, and the model's text is labelled INFERRED, never VERIFIED.

Usage:
  ROUTER_API_KEY=... python3 scripts/seat_adapter.py --thread <thread> \
      --router-url https://<router-host> [--seat perplexity] [--model sonar]
Exit: 0 written or nothing to answer, 2 refused (nothing written).
Then commit on branch council/<seat>/<thread> and open a PR to main.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from council_check import BROKEN, FILE_RE, SECRET_RES, run, seal  # noqa: E402

MAX_REPLY_CHARS = 32_000
SYSTEM_PROMPT = (
    "You are the {seat} seat on the Juss & Co AI council. You are answering one "
    "message on a public, append-only ledger. Reply in plain text. Label every "
    "factual claim VERIFIED, INFERRED, UNKNOWN, BLOCKED or FAIL, and cite sources "
    "for anything you call VERIFIED. You cannot approve, merge, deploy or grant "
    "authority: the founder decides. Never include secrets, credentials or "
    "private personal data."
)


class Refused(Exception):
    """Adapter refused to write. The message is safe to show (no secrets)."""


def http_transport(url, headers, payload, timeout=60):
    """POST JSON; return (status, raw_bytes). Never raises on HTTP status."""
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise Refused(f"router unreachable: {type(exc).__name__}") from None


def latest_message(tdir):
    files = sorted(p for p in tdir.glob("*.json") if FILE_RE.match(p.name))
    if not files:
        return None, None
    path = files[-1]
    return path, json.loads(path.read_text(encoding="utf-8"))


def has_secret(text):
    return any(rx.search(text) for rx in SECRET_RES)


def build_request(seat, incoming, model):
    claims = "\n".join(f"[{c['label']}] {c['text']}" for c in incoming.get("claims", []))
    fp = incoming["state"]["immutableFingerprint"]
    user = (
        f"Thread: {incoming['thread']} (seq {incoming['seq']}, phase {incoming['phaseSeam']})\n"
        f"From: {incoming['from']}\n"
        f"Bound to: {fp['repo']}@{fp['branch']} {fp['head']}\n\n"
        f"Claims:\n{claims or '(none)'}\n\nMessage:\n{incoming['body']}"
    )
    body = {"messages": [
        {"role": "system", "content": SYSTEM_PROMPT.format(seat=seat)},
        {"role": "user", "content": user},
    ]}
    if model:
        body["model"] = model
    return body


def extract_reply(raw):
    try:
        data = json.loads(raw.decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError, UnicodeDecodeError):
        raise Refused("router reply is not a chat completion") from None
    if not isinstance(content, str) or not content.strip():
        raise Refused("router reply has empty content")
    if len(content) > MAX_REPLY_CHARS:
        raise Refused(f"reply longer than {MAX_REPLY_CHARS} characters")
    model = data.get("model") if isinstance(data.get("model"), str) else "unknown"
    rid = data.get("id") if isinstance(data.get("id"), str) else "unknown"
    return content, model, rid


def answer(root, thread, seat, router_url, api_key, model=None,
           transport=http_transport, now=None):
    """Return the written message path, or None when nothing is addressed to seat."""
    root = Path(root)
    tdir = root / "council" / "threads" / thread
    in_path, incoming = latest_message(tdir)
    if incoming is None or incoming.get("to") != seat or incoming.get("from") == seat:
        return None
    if not api_key:
        raise Refused("ROUTER_API_KEY is not set")
    if not router_url.startswith("https://") and not router_url.startswith("http://127.0.0.1"):
        raise Refused("router URL must be https")

    pre = run(root)
    if pre.code == BROKEN:
        raise Refused("thread is BROKEN before answering; fix the ledger first")

    payload = json.dumps(build_request(seat, incoming, model)).encode("utf-8")
    status, raw = transport(
        router_url.rstrip("/") + "/v1/chat/completions",
        {"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        payload,
    )
    if status != 200:
        raise Refused(f"router returned HTTP {status}")
    content, used_model, rid = extract_reply(raw)
    if has_secret(content) or has_secret(raw.decode("utf-8", "replace")):
        raise Refused("credential-like string in reply; nothing written")

    seq = incoming["seq"] + 1
    to = incoming["from"]
    stamp = (now or dt.datetime.now(dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    name = f"{seq:04d}-{seat}-{to}"
    att_rel = f"{name}.router-response.json"
    digest = hashlib.sha256(raw).hexdigest()
    msg = seal({
        "schema": "juss/council-message@v1",
        "thread": thread,
        "seq": seq,
        "from": seat,
        "to": to,
        "createdAt": stamp,
        "phaseSeam": "RECORD",
        "state": {"immutableFingerprint": dict(incoming["state"]["immutableFingerprint"])},
        "claims": [
            {"label": "VERIFIED", "text": (
                f"Seat router returned HTTP 200 at {stamp} (model {used_model}, id {rid}); "
                f"raw response attached as {att_rel}, sha256 {digest}.")},
            {"label": "INFERRED", "text": (
                f"The body is {seat} model output answering seq {incoming['seq']} "
                f"({in_path.name}); it is not independently fact-checked and grants nothing.")},
        ],
        "authority": {"decisionOwner": "founder", "grantsExecutionAuthority": False},
        "body": content,
        "attachments": [{"path": att_rel, "sha256": digest}],
        "prevHash": incoming["proofCookie"],
    })

    out = tdir / f"{name}.json"
    att = tdir / "attachments" / att_rel
    if out.exists() or att.exists():
        raise Refused(f"{out.name} already exists")
    att.parent.mkdir(parents=True, exist_ok=True)
    att.write_bytes(raw)
    out.write_text(json.dumps(msg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    post = run(root)
    if post.code == BROKEN or any(thread in line and line.startswith("UNVERIFIED")
                                  for line in post.lines):
        out.unlink()
        att.unlink()
        raise Refused("written message failed the checker; rolled back")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--thread", required=True)
    ap.add_argument("--seat", default="perplexity")
    ap.add_argument("--router-url", required=True)
    ap.add_argument("--model")
    args = ap.parse_args(argv)
    try:
        out = answer(args.root, args.thread, args.seat, args.router_url,
                     os.environ.get("ROUTER_API_KEY", ""), args.model)
    except Refused as exc:
        print(f"REFUSED: {exc}")
        return 2
    if out is None:
        print(f"NOTHING: latest message in {args.thread} is not addressed to {args.seat}")
        return 0
    print(f"WROTE: {out}")
    print(f"NEXT: commit on council/{args.seat}/{args.thread} and open a PR to main")
    return 0


if __name__ == "__main__":
    sys.exit(main())
