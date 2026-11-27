#!/usr/bin/env python3
"""Fail-closed checks for the publicly viewable, NON-AUTHENTICATING Council-Bus design preview."""
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import sys

PREVIEW = Path('site/preview.html')


class Inspect(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.issues = []
        self.scripts = []
        self.in_script = False
        self.inline = []
        self.has_csp = False
        self.has_noindex = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in {'iframe', 'object', 'embed', 'base'}:
            self.issues.append(f'forbidden active element: {tag}')
        if tag == 'script':
            self.in_script = True
            if a.get('src'):
                self.issues.append('external scripts are forbidden')
        if tag == 'meta' and a.get('http-equiv', '').lower() == 'content-security-policy':
            p = a.get('content', '')
            self.has_csp = "connect-src 'none'" in p and "form-action 'none'" in p and "default-src 'none'" in p
        if tag == 'meta' and a.get('name') == 'robots':
            self.has_noindex = 'noindex' in a.get('content', '')
        if tag == 'form' and a.get('action', '').strip():
            self.issues.append('forms must not submit to a server')
        for key, val in attrs:
            if key.lower().startswith('on'):
                self.issues.append('inline event handler forbidden')
            if key in ('src', 'href') and val and val.lower().startswith(('http:', 'https:', '//', 'javascript:')):
                self.issues.append(f'external or executable {key} forbidden')

    def handle_data(self, data):
        if self.in_script:
            self.inline.append(data)

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_script = False
            self.scripts.append(''.join(self.inline))
            self.inline.clear()


def validate(text: str) -> list[str]:
    i = Inspect()
    i.feed(text)
    i.close()
    problems = i.issues
    if not i.has_csp:
        problems.append('no fail-closed network/form CSP')
    if not i.has_noindex:
        problems.append('no noindex marker')
    if 'Interactive design prototype' not in text or 'No live account or provider connections' not in text:
        problems.append('simulation disclosure missing')
    if len(i.scripts) != 3:
        problems.append('unexpected inline script count')
    if text.count('data:image/webp;base64,') != 1:
        problems.append('one embedded approved scenery asset required')
    if 'setTimeout(rotate,7000)' not in text:
        problems.append('automatic seven-second quotes missing')
    if 'id="scene-quote-line"' in text or 'class="scene-quote-card"' in text:
        problems.append('separate scenic quote card or layout section must not exist')
    if text.count('class="ambient-quote"') != 4:
        problems.append('all four public screens must use directly overlaid quotes')
    if '.cinematic .ambient-quote{' not in text or 'position:absolute;' not in text:
        problems.append('ambient quote positioning missing')
    if '.cinematic .hero-welcome::before,.cinematic .auth-shell::before{' not in text:
        problems.append('extra scenic frame suppression missing')
    for forbidden in ('id="scene-quote-pause"', 'id="scene-quote-next"', 'id="scene-quote-count"', 'XMLHttpRequest(', 'fetch(', 'WebSocket(', 'localStorage.', 'eval(', 'new Function('):
        if forbidden in text:
            problems.append('forbidden feature or network primitive: ' + forbidden)
    if re.search(r'(?:sk-proj|sk_live|sk_test|gh[pousr]_|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY)', text, re.I):
        problems.append('credential-shaped data detected')
    for number, js in enumerate(i.scripts, start=1):
        try:
            check = subprocess.run(['node', '--check'], input=js, text=True, capture_output=True, timeout=15)
            if check.returncode:
                problems.append(f'script {number} syntax error')
        except (FileNotFoundError, subprocess.TimeoutExpired):
            problems.append('Node required for script validation')
            break
    return problems


def main():
    if not PREVIEW.is_file() or PREVIEW.is_symlink():
        print('FAIL: preview missing or symlink', file=sys.stderr)
        raise SystemExit(1)
    if PREVIEW.stat().st_size > 1024 * 1024:
        print('FAIL: preview unexpectedly large', file=sys.stderr)
        raise SystemExit(1)
    issues = validate(PREVIEW.read_text(encoding='utf-8'))
    if issues:
        for issue in issues:
            print('FAIL:', issue, file=sys.stderr)
        raise SystemExit(1)
    print('PASS: interactive preview is isolated, CSP-restricted, and syntax-validated')


if __name__ == '__main__':
    main()
