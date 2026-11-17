#!/usr/bin/env python3
"""Seal a draft message: add bodyHash and proofCookie. Usage: council_seal.py DRAFT.json > NNNN-from-to.json"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from council_check import seal  # noqa: E402

print(json.dumps(seal(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))), indent=2, ensure_ascii=False))
