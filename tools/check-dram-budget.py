#!/usr/bin/env python3
"""Parse `idf.py size` output and fail if static DRAM exceeds the budget.

Called from .github/workflows/build-firmware.yml after the build. The
classic ESP32-CAM has ~125 KB DRAM; everything beyond ~100 KB starts
starving lwIP's pbuf pool, and UDP sends from libpeer return ENOMEM
(WebRTC video silently breaks). Failing the build at PR time beats
finding out by reflashing.

Usage: idf.py size 2>&1 | python3 tools/check-dram-budget.py
"""
import re
import sys

BUDGET_BYTES = 100_000
out = sys.stdin.read()
sys.stdout.write(out)

m = re.search(r'DRAM\s+\|\s+(\d+)', out)
if not m:
    print('::error::Could not parse DRAM size from idf.py size output')
    sys.exit(1)

dram = int(m.group(1))
margin = BUDGET_BYTES - dram
print('::group::Static DRAM budget')
print(f'  used:    {dram:>7,} B')
print(f'  budget:  {BUDGET_BYTES:>7,} B')
print(f'  margin:  {margin:>7,} B ({100 * margin / BUDGET_BYTES:+.1f}%)')
print('::endgroup::')

if dram > BUDGET_BYTES:
    over = dram - BUDGET_BYTES
    print(
        f'::error::Static DRAM {dram:,} B exceeds budget {BUDGET_BYTES:,} B '
        f'by {over:,} B. Move static buffers to PSRAM (heap_caps_calloc with '
        f'MALLOC_CAP_SPIRAM) or shrink them.'
    )
    sys.exit(1)
