#!/usr/bin/env python3
"""
ipo_bundle.py <ECU_BASE>: analysis bundle for one ECU to enrich its layout map.

Three sections:
  1. SCREEN MASKS: label list (comma-sep) paired with result-key list
     (semicolon-sep). Counts can differ (some labels are headers), align by
     meaning not blind zip.
  2. JOB BINDINGS: for each result key, the EDIABAS job(s) that read it
     (STATUS_*, MESSWERTBLOCK_LESEN + hex args).
  3. INPUT PROMPTS: input-requiring strings with nearby job context.
"""
import os, sys, re, subprocess
from collections import defaultdict

HERE = os.path.dirname(__file__)
SGDAT = os.path.join(HERE, "..", "vendor", "EC-APPS", "INPA", "SGDAT")

JOB_RE = re.compile(r'^(MESSWERTBLOCK_LESEN|MESSWERTE_LESEN|STATUS_[A-Z0-9_]+|'
                    r'STATUS_LESEN|MW_[A-Z0-9_]+|[A-Z0-9_]+_LESEN)$')
KEY_LINE_RE = re.compile(r'^[A-Z0-9_]+_(WERT|TEXT)(;[A-Z0-9_]+_(WERT|TEXT))*$')
SINGLEKEY_RE = re.compile(r'^[A-Z0-9_]+_(WERT|TEXT)$')
HEX_RE = re.compile(r'^0x[0-9A-Fa-f]+(,\s*0x[0-9A-Fa-f]+)*$')
PROC_RE = re.compile(r'^s_[a-z0-9_]+$')
INPUT_RE = re.compile(r'(parameter input|input Coding|input clima|Eingabe|'
                      r'eingeben|geben sie|request telegram|standby|abfrage)', re.I)


def resolve(base):
    for ext in (".IPO", ".ipo"):
        p = os.path.join(SGDAT, base + ext)
        if os.path.exists(p):
            return p
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__); return 2
    base = sys.argv[1]
    path = resolve(base)
    if not path:
        print(f"not found: {base}", file=sys.stderr); return 1

    lines = [l.rstrip() for l in subprocess.run(
        ["strings", "-n", "3", path], capture_output=True, text=True,
        errors="replace").stdout.splitlines()]

    # 1. SCREEN MASKS: label-list line followed by key-list line
    masks = []
    for i, ln in enumerate(lines):
        if KEY_LINE_RE.match(ln) and ";" in ln:
            keys = ln.split(";")
            prev = lines[i - 1] if i > 0 else ""
            is_labels = ("," in prev and "_WERT" not in prev and "_TEXT" not in prev
                         and ";" not in prev and re.search(r"[A-Za-z]{3,}", prev)
                         and not prev.startswith("0x"))
            if is_labels:
                masks.append((prev, keys))
    # de-dupe
    seen, umask = set(), []
    for lbl, keys in masks:
        sig = (lbl, tuple(keys))
        if sig not in seen:
            seen.add(sig); umask.append((lbl, keys))

    # 2. JOB BINDINGS: which job reads each key
    # track current job + hex args, attribute each key line to it
    key_jobs = defaultdict(set)
    cur_job = cur_args = None
    for i, ln in enumerate(lines):
        if JOB_RE.match(ln):
            cur_job = ln
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            cur_args = nxt if HEX_RE.match(nxt) else None
            continue
        if KEY_LINE_RE.match(ln) and cur_job:
            for k in ln.split(";"):
                key_jobs[k].add((cur_job, cur_args))
        elif SINGLEKEY_RE.match(ln) and cur_job:
            key_jobs[ln].add((cur_job, cur_args))

    # 3. INPUT PROMPTS
    inputs = []
    cur_job = None
    for i, ln in enumerate(lines):
        if JOB_RE.match(ln):
            cur_job = ln
        if INPUT_RE.search(ln):
            inputs.append((ln.strip(), cur_job))

    print(f"### ECU {base}  ({len(lines)} strings)\n")
    print(f"## SCREEN MASKS ({len(umask)} unique)")
    for lbl, keys in umask[:200]:
        print(f"  LABELS: {lbl}")
        print(f"  KEYS  : {';'.join(keys)}")
        # job(s) reading the first key, aids attribution
        jb = key_jobs.get(keys[0], set())
        if jb:
            jobstr = ", ".join(f"{j}{(' '+a) if a else ''}" for j, a in sorted(jb, key=lambda t: (t[0], t[1] or "")))
            print(f"  READBY: {jobstr}")
        print()
    print(f"## JOB BINDINGS (key -> reading job)  [{len(key_jobs)} keys]")
    for k in sorted(key_jobs)[:300]:
        jobs = ", ".join(f"{j}{(' '+a) if a else ''}" for j, a in sorted(key_jobs[k], key=lambda t: (t[0], t[1] or "")))
        print(f"  {k} <- {jobs}")
    print(f"\n## INPUT PROMPTS ({len(inputs)})")
    for prompt, job in inputs[:60]:
        print(f"  [{job}] {prompt}")


if __name__ == "__main__":
    main()
