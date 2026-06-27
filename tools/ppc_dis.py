#!/usr/bin/env python3
"""
ppc_dis.py: disassemble a region of the MS45 DME flash (big-endian PowerPC).

Usage:
  ppc_dis.py <file.bin> <offset_hex> [count]    # disassemble count insns from offset
  ppc_dis.py <file.bin> --find <hexbytes>       # find a byte pattern, list offsets
  ppc_dis.py <file.bin> --xref <hexbytes>       # find code referencing a value

DME is a Bosch MS45.1 (MPC555-class PowerPC), flash dump 0x100000 bytes.
Disassembles raw (no ELF) at the file offset. Runtime load base is unknown, so
addresses are FILE offsets unless --base is given.
"""
import sys, re
from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN

def md():
    m = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)
    m.detail = True
    return m

def load(path):
    return open(path, "rb").read()

def disasm(data, off, count, base=0):
    m = md()
    chunk = data[off: off + count * 4 + 64]
    out = []
    for ins in m.disasm(chunk, base + off):
        out.append(f"{ins.address:#08x}: {ins.bytes.hex():<8} {ins.mnemonic:<8} {ins.op_str}")
        if len(out) >= count:
            break
    return out

def find(data, pat):
    b = bytes.fromhex(pat.replace(" ", ""))
    hits, i = [], 0
    while True:
        j = data.find(b, i)
        if j < 0: break
        hits.append(j); i = j + 1
    return hits

def main():
    a = sys.argv[1:]
    if len(a) < 2:
        print(__doc__); return 2
    path = a[0]
    data = load(path)
    base = 0
    if "--base" in a:
        i = a.index("--base"); base = int(a[i+1], 16); del a[i:i+2]
    if a[1] == "--find":
        for h in find(data, a[2]):
            print(f"{h:#08x}")
        return 0
    off = int(a[1], 16)
    count = int(a[2]) if len(a) > 2 else 40
    for line in disasm(data, off, count, base):
        print(line)
    return 0

if __name__ == "__main__":
    sys.exit(main())
