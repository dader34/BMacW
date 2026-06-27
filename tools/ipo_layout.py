#!/usr/bin/env python3
"""
ipo_layout.py: extract INPA screen layouts from compiled .IPO files.

Compiled .IPO files retain readable strings describing each screen: display
labels, the EDIABAS result keys they bind to, the job + args producing them, the
render type (analog gauge vs digital text), units, and input prompts.

Reproduces INPA's on-screen layout deterministically (no LLM) so BMacW renders
the same labels/units/ranges and knows which functions need input.

Usage:
    ipo_layout.py <file.IPO> [--json]        # one ECU
    ipo_layout.py --base <name> [--json]     # resolve <name>.IPO in SGDAT
    ipo_layout.py --list                     # list ECU base names

Heuristics from the observed string layout in BMW MSD/MSV/MEVD .IPOs:
  - label list (comma-sep) immediately followed by a result-key list
    (semicolon-sep STAT_*_WERT / *_WERT names).
  - nearest preceding EDIABAS job token (MESSWERTBLOCK_LESEN, STATUS_LESEN,
    STATUS_*, MESSWERTE_*) plus any hex/arg line after it give the call.
  - ergebnisAnalogAusgabe nearby = gauge bars; ergebnisDigitalAusgabe = text.
  - lines with 'input'/'Eingabe'/'parameter input' = input-required.
"""
import sys, os, re, json, subprocess

SGDAT = os.path.join(os.path.dirname(__file__), "..", "vendor", "EC-APPS",
                     "INPA", "SGDAT")

# EDIABAS jobs driving a measurement/status screen
JOB_RE = re.compile(r'^(MESSWERTBLOCK_LESEN|MESSWERTE_LESEN|STATUS_LESEN|'
                    r'STATUS_[A-Z0-9_]+|MW_[A-Z0-9_]+|MESSWERT[A-Z0-9_]*|'
                    r'LESE_[A-Z0-9_]+|[A-Z0-9_]*_LESEN)$')
RESULTKEY_RE = re.compile(r'^[A-Z0-9_]+_WERT(;[A-Z0-9_]+_WERT)*$')
HEXARG_RE = re.compile(r'^(0x[0-9A-Fa-f]+)(,0x[0-9A-Fa-f]+)*$')
UNIT_RE = re.compile(r'^\s*-?\d*\s*(%|mg/stk|mg/hub|V|A|°C|°KW|°|1/min|rpm|U/min|'
                     r'km/h|mbar|hpa|bar|Nm|ms|l/h|ohm|g/s|kPa)\s*$', re.I)
INPUT_RE = re.compile(r'(parameter input|input Coding|input clima|Eingabe|'
                      r'eingeben|geben sie|request telegram|abfrage\b)', re.I)


def ipo_strings(path):
    """readable strings from a compiled .IPO, in file order"""
    try:
        out = subprocess.run(["strings", "-n", "3", path], capture_output=True,
                             text=True, errors="replace").stdout
    except FileNotFoundError:
        with open(path, "rb") as f:
            data = f.read()
        out = "".join(c if 32 <= ord(c) < 127 else "\n"
                      for c in data.decode("latin-1"))
    return [ln.rstrip() for ln in out.splitlines()]


def fix_de(s):
    """normalise spacing; CP1252/umlaut mangling is lossy so not repaired"""
    return re.sub(r"\s+", " ", s).strip()


def looks_like_labels(s):
    if ";" in s or "_WERT" in s:
        return False
    if not ("," in s or len(s.split()) >= 2):
        return False
    # need at least one alpha word of len>=3
    if not re.search(r"[A-Za-zÄÖÜäöü]{3,}", s):
        return False
    # exclude code tokens
    if re.match(r"^[a-z_]+$", s) and "," not in s:
        return False
    return True


def extract(path):
    lines = ipo_strings(path)
    screens = []
    inputs = []
    last_job = None
    last_args = None

    for i, ln in enumerate(lines):
        if JOB_RE.match(ln):
            last_job = ln
            last_args = None
            continue
        if HEXARG_RE.match(ln) and last_job and last_args is None:
            last_args = ln
            continue
        if INPUT_RE.search(ln):
            inputs.append({"prompt": fix_de(ln), "near_job": last_job})
            continue
        # label list followed by result-key list = a screen row group
        if RESULTKEY_RE.match(ln):
            keys = ln.split(";")
            label_line = lines[i - 1] if i > 0 else ""
            labels = [fix_de(x) for x in label_line.split(",")] \
                if looks_like_labels(label_line) else []
            # scan a small window for analog/digital markers + units
            window = " ".join(lines[max(0, i - 6):i + 4])
            render = ("analog" if "ergebnisAnalog" in window
                      else "digital" if "ergebnisDigital" in window
                      else "value")
            units = UNIT_RE.findall(" ".join(lines[max(0, i - 3):i + 3]))
            screens.append({
                "job": last_job,
                "args": last_args,
                "result_keys": keys,
                "labels": labels if len(labels) == len(keys) else labels[:len(keys)],
                "render": render,
                "units": [u for u in units] if units else [],
            })

    # de-dupe; strings table often repeats screens
    seen, uniq = set(), []
    for s in screens:
        sig = (s["job"], tuple(s["result_keys"]))
        if sig in seen:
            continue
        seen.add(sig)
        uniq.append(s)
    return {"ecu": os.path.basename(path), "screens": uniq, "inputs": inputs}


def resolve(base):
    for ext in (".IPO", ".ipo"):
        p = os.path.join(SGDAT, base + ext)
        if os.path.exists(p):
            return p
    return None


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--list":
        bases = sorted({os.path.splitext(f)[0]
                        for f in os.listdir(SGDAT)
                        if f.lower().endswith(".ipo")})
        print("\n".join(bases))
        return 0
    if args[0] == "--base":
        path = resolve(args[1])
        if not path:
            print(f"not found: {args[1]}", file=sys.stderr)
            return 1
    else:
        path = args[0]
    data = extract(path)
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"ECU {data['ecu']}: {len(data['screens'])} screens, "
              f"{len(data['inputs'])} input-prompts")
        for s in data["screens"][:30]:
            lab = " | ".join(s["labels"]) if s["labels"] else "(no labels)"
            print(f"  [{s['render']:7}] {s['job']} {s['args'] or ''}")
            print(f"            {lab}")
            print(f"            keys: {';'.join(s['result_keys'])}"
                  f"  units: {s['units']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
