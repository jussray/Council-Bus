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
import re
import os
import sys
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from council_check import BROKEN, FILE_RE, SECRET_RES, run, seal  # noqa: E402

MAX_REPLY_CHARS = 32_000
MAX_HTTP_REPLY_BYTES = 128 * 1024
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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward Council router or Access credentials to a Location URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _credential_safe_open(req, timeout):
    """Per-call opener with normal transport handling but no HTTP redirects."""
    return urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout)


def _read_bounded_http_body(response):
    """Never buffer an unlimited remote success or error body in memory."""
    body = response.read(MAX_HTTP_REPLY_BYTES + 1)
    if len(body) > MAX_HTTP_REPLY_BYTES:
        raise Refused("router response exceeds maximum allowed size")
    return body


def http_transport(url, headers, payload, timeout=60):
    """POST JSON; return (status, raw_bytes). Never raises on HTTP status."""
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with _credential_safe_open(req, timeout=timeout) as resp:
            return resp.status, _read_bounded_http_body(resp)
    except urllib.error.HTTPError as exc:
        return exc.code, _read_bounded_http_body(exc)
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
        {"content-type": "application/json", "authorization": f"Bearer {api_key}",
         "x-council-seat": seat},
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



# The production Council Worker exposes only the approval-gated workflow API.
# The legacy answer() helper above is kept for compatibility tests against
# historical per-seat routers; the CLI uses enqueue()/collect() by default.
WORKFLOW_PROVIDERS = {
    "chatgpt": "openai",
    "claude": "anthropic",
    "deepseek": "deepseek",
    "muse": "meta",
    "perplexity": "perplexity",
}
MAX_WORKFLOW_REPLY_BYTES = 128 * 1024


def get_transport(url, headers, timeout=60):
    """GET JSON from a Workflow status endpoint without exposing error bodies."""
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _credential_safe_open(req, timeout=timeout) as resp:
            raw = resp.read(MAX_WORKFLOW_REPLY_BYTES + 1)
            if len(raw) > MAX_WORKFLOW_REPLY_BYTES:
                raise Refused("workflow status response too large")
            return resp.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise Refused(f"workflow status unreachable: {type(exc).__name__}") from None


def _workflow_context(root, thread, seat, router_url, api_key):
    if seat not in WORKFLOW_PROVIDERS:
        raise Refused("unknown Council seat")
    if not api_key:
        raise Refused("seat router authentication is not configured")
    parsed = urllib.parse.urlsplit(router_url)
    if (parsed.scheme != "https" and
            not (parsed.scheme == "http" and parsed.hostname == "127.0.0.1")):
        raise Refused("router URL must be https")
    if not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Refused("router URL cannot include credentials, query, or fragment")
    root = Path(root)
    tdir = root / "council" / "threads" / thread
    in_path, incoming = latest_message(tdir)
    if incoming is None or incoming.get("to") != seat or incoming.get("from") == seat:
        return None
    if incoming.get("thread") != thread:
        raise Refused("thread mismatch")
    pre = run(root)
    if pre.code == BROKEN:
        raise Refused("thread is BROKEN before answering; fix the ledger first")
    return root, tdir, in_path, incoming


def _workflow_identity(thread, seat, incoming):
    """Bind a Workflow ID to the exact sealed latest Council message."""
    key = hashlib.sha256(f"{thread}:{seat}:{incoming['proofCookie']}".encode()).hexdigest()
    instance = "council-" + seat + "-" + hashlib.sha256(
        f"{seat}:{key}".encode()
    ).hexdigest()[:32]
    return key, instance


def _workflow_headers(seat, api_key, access_token=None):
    headers = {"authorization": "Bearer " + api_key,
               "x-council-seat": seat}
    if access_token:
        headers["Cf-Access-Token"] = access_token
    return headers


def enqueue(root, thread, seat, router_url, api_key,
            transport=http_transport, access_token=None, model=None):
    """Queue exactly one deterministic job. Never approve or write a ledger reply."""
    if model is not None:
        raise Refused("model selection is server-controlled for durable Council")
    context = _workflow_context(root, thread, seat, router_url, api_key)
    if context is None:
        return None
    _, _, _, incoming = context
    dedupe_key, expected_id = _workflow_identity(thread, seat, incoming)
    payload = json.dumps(build_request(seat, incoming, model=None)).encode("utf-8")
    headers = _workflow_headers(seat, api_key, access_token)
    headers.update({"content-type": "application/json", "idempotency-key": dedupe_key})
    status, raw = transport(router_url.rstrip("/") + "/v1/council/workflows", headers, payload)
    if status != 202:
        raise Refused(f"workflow intake returned HTTP {status}")
    try:
        if len(raw) > 4096:
            raise ValueError("response too large")
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, TypeError):
        raise Refused("workflow intake returned invalid JSON") from None
    if (not isinstance(data, dict) or data.get("id") != expected_id or
            data.get("state") != "queued_for_approval" or data.get("approved") is not False):
        raise Refused("workflow intake receipt did not match the sealed message")
    return expected_id


def collect(root, thread, seat, router_url, api_key, workflow_id,
            transport=get_transport, now=None, access_token=None):
    """Write only an approved, completed, message-bound sanitized Workflow receipt.

    Collect never submits a provider call and never sends an approval event.
    """
    context = _workflow_context(root, thread, seat, router_url, api_key)
    if context is None:
        return None
    root, tdir, in_path, incoming = context
    _, expected_id = _workflow_identity(thread, seat, incoming)
    if workflow_id != expected_id:
        raise Refused("workflow ID is not bound to the current sealed message")
    headers = _workflow_headers(seat, api_key, access_token)
    status, raw = transport(
        router_url.rstrip("/") + "/v1/council/workflows/" + expected_id, headers
    )
    if status != 200:
        raise Refused(f"workflow status returned HTTP {status}")
    try:
        if len(raw) > MAX_WORKFLOW_REPLY_BYTES:
            raise ValueError("response too large")
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, TypeError):
        raise Refused("invalid Workflow status receipt") from None
    if (not isinstance(data, dict) or data.get("id") != expected_id or
            data.get("status") != "complete"):
        raise Refused("workflow is not completed or does not match its ID")
    output = data.get("output")
    if (not isinstance(output, dict) or output.get("state") != "completed" or
            output.get("seat") != seat or
            output.get("provider") != WORKFLOW_PROVIDERS[seat]):
        raise Refused("workflow has no valid approved provider result")
    content, response_id = output.get("content"), output.get("response_id")
    if not isinstance(content, str) or not content.strip() or len(content) > MAX_REPLY_CHARS:
        raise Refused("workflow reply is empty or too large")
    if (not isinstance(response_id, str) or
            not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", response_id)):
        raise Refused("workflow provider response ID invalid")
    # Construct an allowlisted receipt: do not persist full status, raw provider
    # payloads, HTTP headers, access tokens or Cloudflare exception details.
    receipt = {
        "instance_id": expected_id,
        "state": "completed",
        "seat": seat,
        "provider": output["provider"],
        "response_id": response_id,
        "content": content,
    }
    sanitized = (json.dumps(receipt, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    if has_secret(content) or has_secret(sanitized.decode("utf-8")):
        raise Refused("credential-shaped text in workflow result; nothing written")
    seq = incoming["seq"] + 1
    other = incoming["from"]
    stamp = (now or dt.datetime.now(dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    name = f"{seq:04d}-{seat}-{other}"
    attachment_name = f"{name}.workflow-receipt.json"
    digest = hashlib.sha256(sanitized).hexdigest()
    msg = seal({
        "schema": "juss/council-message@v1",
        "thread": thread,
        "seq": seq,
        "from": seat,
        "to": other,
        "createdAt": stamp,
        "phaseSeam": "RECORD",
        "state": {"immutableFingerprint": dict(incoming["state"]["immutableFingerprint"])},
        "claims": [
            {"label": "VERIFIED", "text": (
                f"Council Workflow {expected_id} reported completed at {stamp} "
                f"with provider {output['provider']} and response ID {response_id}; "
                f"sanitized receipt {attachment_name}, sha256 {digest}.")},
            {"label": "INFERRED", "text": (
                f"The body is {seat} model output answering seq {incoming['seq']} "
                f"({in_path.name}); it is not independently fact-checked or approved as a claim.")},
        ],
        "authority": {"decisionOwner": "founder", "grantsExecutionAuthority": False},
        "body": content,
        "attachments": [{"path": attachment_name, "sha256": digest}],
        "prevHash": incoming["proofCookie"],
    })
    out = tdir / f"{name}.json"
    attachment = tdir / "attachments" / attachment_name
    if out.exists() or attachment.exists():
        raise Refused("workflow reply or receipt already exists")
    attachment.parent.mkdir(parents=True, exist_ok=True)
    try:
        attachment.write_bytes(sanitized)
        out.write_text(json.dumps(msg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        post = run(root)
        if (post.code == BROKEN or
                any(thread in line and line.startswith("UNVERIFIED") for line in post.lines)):
            raise Refused("workflow reply failed the ledger checker")
    except Exception:
        out.unlink(missing_ok=True)
        attachment.unlink(missing_ok=True)
        raise
    return out

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--thread", required=True)
    ap.add_argument("--seat", default="perplexity")
    ap.add_argument("--router-url", required=True)
    ap.add_argument("--action", choices=("submit", "collect"), default="submit",
                    help="queue for founder approval, or collect an already completed Workflow")
    ap.add_argument("--workflow-id", help="required for --action collect")
    ap.add_argument("--model", help="unsupported in durable mode; configured server-side")
    args = ap.parse_args(argv)
    try:
        api_key = (os.environ.get("ROUTER_API_KEY_" + args.seat.upper())
                   or os.environ.get("ROUTER_API_KEY", ""))
        access_token = os.environ.get("CF_ACCESS_TOKEN") or None
        if args.action == "submit":
            instance = enqueue(args.root, args.thread, args.seat, args.router_url,
                               api_key, access_token=access_token, model=args.model)
            if instance is None:
                print(f"NOTHING: latest message in {args.thread} is not addressed to {args.seat}")
                return 0
            print(f"QUEUED: {instance}")
            print("NEXT: founder approves the Workflow; then use --action collect --workflow-id <id>")
            return 0
        if not args.workflow_id:
            raise Refused("--workflow-id is required for --action collect")
        out = collect(args.root, args.thread, args.seat, args.router_url, api_key,
                      args.workflow_id, access_token=access_token)
    except Refused as exc:
        print(f"REFUSED: {exc}")
        return 2
    if out is None:
        print(f"NOTHING: latest message in {args.thread} is not addressed to {args.seat}")
        return 0
    print(f"WROTE: {out}")
    print(f"NEXT: review content, commit on council/{args.seat}/{args.thread}, open a PR to main")
    return 0


if __name__ == "__main__":
    sys.exit(main())
