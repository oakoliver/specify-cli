"""Regenerate CORE_PACK_HASHES in tests/yaml.test.ts with PyYAML.

Usage: python3 tests/fixtures/generate/yaml_hashes.py [repo_root]
Prints the JSON object to paste into tests/yaml.test.ts (one line).
Requires PyYAML 6.0.x (the version upstream spec-kit resolves).
"""
import hashlib
import json
import math
import os
import sys

import yaml

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def sort_deep(v):
    if isinstance(v, dict):
        return {str(k): sort_deep(v[k]) for k in sorted(v, key=str)}
    if isinstance(v, list):
        return [sort_deep(x) for x in v]
    if isinstance(v, float) and not math.isfinite(v):
        return 'nan' if math.isnan(v) else ('inf' if v > 0 else '-inf')
    return v


def sha16(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]


def frontmatter(text):
    if not text.startswith('---\n'):
        return None
    end = text.find('\n---', 4)
    return text[4:end + 1] if end > 0 else None


def entry(src):
    value = yaml.safe_load(src)
    return [
        sha16(json.dumps(sort_deep(value), separators=(',', ':'), ensure_ascii=False)),
        sha16(yaml.safe_dump(value)),
        sha16(yaml.safe_dump(value, sort_keys=False, allow_unicode=True)),
    ]


out = {}
yml, md = [], []
for d, _, files in os.walk(os.path.join(ROOT, 'core_pack')):
    for f in files:
        rel = os.path.relpath(os.path.join(d, f), ROOT)
        if f.endswith(('.yml', '.yaml')):
            yml.append(rel)
        elif f.endswith('.md'):
            md.append(rel)
for rel in sorted(yml, key=lambda r: (r.split('/')[1], r)):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        out[rel] = entry(fh.read())
for rel in sorted(md, key=lambda r: (r.split('/')[1], r)):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        fm = frontmatter(fh.read())
    if fm is not None:
        out[rel + '#frontmatter'] = entry(fm)
print(json.dumps(out, ensure_ascii=False))
