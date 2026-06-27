#!/usr/bin/env python3
"""
ipo_extract_all.py: run the layout extractor over every .IPO, emit per-ECU JSON
plus a combined corpus, with job attribution by procedure tracing.

Output:
  data/inpa-layouts/<ECU>.json     one file per ECU
  data/inpa-layouts/_index.json    {ecu: {screens, inputs, analog, jobs[]}}
  data/inpa-layouts/_stats.txt     summary + dense ECUs worth agent review
"""
import os, sys, json, re, subprocess
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(__file__)
SGDAT = os.path.join(HERE, "..", "vendor", "EC-APPS", "INPA", "SGDAT")
OUT = os.path.join(HERE, "..", "data", "inpa-layouts")

JOB_RE = re.compile(r'^(MESSWERTBLOCK_LESEN|MESSWERTE_LESEN|STATUS_LESEN|'
                    r'STATUS_[A-Z0-9_]+|MW_[A-Z0-9_]+|MESSWERT[A-Z0-9_]*|'
                    r'LESE_[A-Z0-9_]+|[A-Z0-9_]+_LESEN)$')
RESULTKEY_RE = re.compile(r'^[A-Z0-9_]+_(WERT|TEXT)(;[A-Z0-9_]+_(WERT|TEXT))*$')
HEXARG_RE = re.compile(r'^(0x[0-9A-Fa-f]+)(,\s*0x[0-9A-Fa-f]+)*$')
UNIT_RE = re.compile(r'(%|mg/stk|mg/hub|1/min|km/h|°C|°KW|°|U/min|rpm|mbar|hPa|'
                     r'\bbar\b|\bNm\b|\bms\b|l/h|\bohm\b|g/s|kPa|\bV\b|\bA\b)')
INPUT_RE = re.compile(r'(parameter input|input Coding|input clima|Eingabe|'
                      r'eingeben|geben sie|request telegram|standby current)', re.I)
PROC_RE = re.compile(r'^s_[a-z0-9_]+$')


def ipo_strings(path):
    out = subprocess.run(["strings", "-n", "3", path], capture_output=True,
                         text=True, errors="replace").stdout
    return [ln.rstrip() for ln in out.splitlines()]


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def looks_like_labels(s):
    if ";" in s or "_WERT" in s or "_TEXT" in s:
        return False
    if not re.search(r"[A-Za-zÄÖÜäöü]{3,}", s):
        return False
    if re.fullmatch(r"[a-z_0-9]+", s):
        return False
    return True


def extract(path):
    lines = ipo_strings(path)
    screens, inputs = [], []
    # current measurement job + args + procedure
    cur_job = cur_args = cur_proc = None
    job_set = set()

    for i, ln in enumerate(lines):
        if PROC_RE.match(ln):
            cur_proc = ln
            continue
        if JOB_RE.match(ln):
            cur_job = ln
            cur_args = None
            job_set.add(ln)
            continue
        if HEXARG_RE.match(ln) and cur_job and cur_args is None:
            cur_args = norm(ln)
            continue
        if INPUT_RE.search(ln):
            inputs.append({"prompt": norm(ln), "proc": cur_proc,
                           "job": cur_job, "args": cur_args})
            continue
        if RESULTKEY_RE.match(ln):
            keys = ln.split(";")
            prev = lines[i - 1] if i > 0 else ""
            labels = [norm(x) for x in prev.split(",")] if looks_like_labels(prev) else []
            window = "\n".join(lines[max(0, i - 8):i + 6])
            render = ("analog" if "ergebnisAnalog" in window
                      else "digital" if "ergebnisDigital" in window else "value")
            units = sorted(set(UNIT_RE.findall("\n".join(lines[max(0, i - 4):i + 4]))))
            screens.append({
                "proc": cur_proc, "job": cur_job, "args": cur_args,
                "result_keys": keys,
                "labels": labels if len(labels) == len(keys) else labels[:len(keys)],
                "render": render, "units": units,
            })

    # de-dupe by (job, keys)
    seen, uniq = set(), []
    for s in screens:
        sig = (s["job"], tuple(s["result_keys"]))
        if sig not in seen:
            seen.add(sig)
            uniq.append(s)
    return {"ecu": os.path.basename(path), "screens": uniq, "inputs": inputs,
            "jobs": sorted(job_set)}


def process(fname):
    path = os.path.join(SGDAT, fname)
    try:
        data = extract(path)
    except Exception as e:
        return fname, None, str(e)
    base = os.path.splitext(fname)[0]
    with open(os.path.join(OUT, base + ".json"), "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    analog = sum(1 for s in data["screens"] if s["render"] == "analog")
    return fname, {"screens": len(data["screens"]), "inputs": len(data["inputs"]),
                   "analog": analog, "jobs": len(data["jobs"]),
                   "no_label": sum(1 for s in data["screens"] if not s["labels"])}, None


def main():
    os.makedirs(OUT, exist_ok=True)
    files = sorted(f for f in os.listdir(SGDAT) if f.lower().endswith(".ipo"))
    index, errors = {}, []
    with ProcessPoolExecutor() as ex:
        for fname, summ, err in ex.map(process, files):
            base = os.path.splitext(fname)[0]
            if err:
                errors.append((fname, err))
            else:
                index[base] = summ
    with open(os.path.join(OUT, "_index.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    total_screens = sum(v["screens"] for v in index.values())
    total_inputs = sum(v["inputs"] for v in index.values())
    # dense = many missing labels or many input prompts, where agent review pays off
    dense = sorted(index.items(),
                   key=lambda kv: (kv[1]["no_label"] + kv[1]["inputs"] * 3),
                   reverse=True)
    with open(os.path.join(OUT, "_stats.txt"), "w") as f:
        f.write(f"ECUs: {len(index)}  screens: {total_screens}  "
                f"input-prompts: {total_inputs}  errors: {len(errors)}\n\n")
        f.write("Top 60 ECUs needing agent review (missing labels / inputs):\n")
        for base, v in dense[:60]:
            f.write(f"  {base:24} screens={v['screens']:4} no_label={v['no_label']:4} "
                    f"inputs={v['inputs']:3} analog={v['analog']:3}\n")
    print(f"done: {len(index)} ECUs, {total_screens} screens, "
          f"{total_inputs} inputs, {len(errors)} errors")
    print(f"output: {OUT}")


if __name__ == "__main__":
    main()
