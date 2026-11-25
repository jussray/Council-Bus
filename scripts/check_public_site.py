#!/usr/bin/env python3
"""Fail-closed static validation of the intentionally public Council-Bus site."""
from html.parser import HTMLParser
from pathlib import Path
import re
import sys

SITE = Path("site/index.html")
ALLOWED_EXTERNAL_PREFIX = "https://github.com/jussray/Council-Bus"
BLOCKED_TAGS = {"script", "iframe", "object", "embed", "form", "base"}


class PublicSiteChecker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.refs = set()
        self.counts = {}
        self.errors = []

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        self.counts[tag] = self.counts.get(tag, 0) + 1
        if tag in BLOCKED_TAGS:
            self.errors.append("active or embedding element forbidden: " + tag)
        for key, value in attrs:
            if key.lower().startswith("on"):
                self.errors.append("inline event handler forbidden: " + key)
            if key in {"src", "href"} and value and (
                value.lower().startswith(("javascript:", "data:", "//"))
                or (key == "src" and value.startswith(("http://", "https://")))
            ):
                self.errors.append("unsafe or remote resource: " + key)
        if data.get("id"):
            if data["id"] in self.ids:
                self.errors.append("duplicate id: " + data["id"])
            self.ids.add(data["id"])
        if tag == "a":
            href = data.get("href") or ""
            if href.startswith("#"):
                self.refs.add(href[1:])
            elif not href.startswith((ALLOWED_EXTERNAL_PREFIX + "/", ALLOWED_EXTERNAL_PREFIX + "#")) and href != ALLOWED_EXTERNAL_PREFIX:
                self.errors.append("unapproved outbound link: " + href)
        if tag == "html" and data.get("lang") != "en":
            self.errors.append("html lang must be en")


def validate() -> list[str]:
    errors = []
    if not SITE.is_file() or SITE.is_symlink():
        return ["site/index.html is missing or is a symlink"]
    if SITE.parent.is_symlink():
        errors.append("site directory must not be a symlink")
    if any(p.is_symlink() for p in SITE.parent.rglob("*")):
        errors.append("site directory contains a symlink")
    text = SITE.read_text(encoding="utf-8")
    if not text.lower().startswith("<!doctype html>"):
        errors.append("missing HTML5 doctype")
    if not text.rstrip().endswith("</html>"):
        errors.append("HTML document not closed")
    if re.search(r"sk-[a-zA-Z0-9_-]{18,}|-----BEGIN (?:RSA|OPENSSH|PRIVATE) KEY", text):
        errors.append("secret-shaped data in public document")
    parser = PublicSiteChecker()
    parser.feed(text)
    parser.close()
    errors.extend(parser.errors)
    for tag in ("html", "head", "title", "body", "header", "main", "nav", "footer", "h1"):
        if parser.counts.get(tag) != 1:
            errors.append(f"expected one <{tag}>; found {parser.counts.get(tag, 0)}")
    for ref in parser.refs:
        if ref not in parser.ids:
            errors.append("broken local anchor: #" + ref)
    if "prefers-reduced-motion" not in text:
        errors.append("reduced-motion support missing")
    return errors


if __name__ == "__main__":
    problems = validate()
    if problems:
        for problem in problems:
            print("SITE CHECK FAIL:", problem, file=sys.stderr)
        sys.exit(1)
    print("SITE CHECK PASS: public page, navigation, and resource isolation validated")
