#!/usr/bin/env python3
"""Run every Python test suite. Exits non-zero if any fails."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUITES = ["test_corridor.py", "test_segmenter.py", "test_service.py", "test_calibrate.py"]

failed = []
for suite in SUITES:
    print(f"\n\033[1m── {suite} ──\033[0m")
    result = subprocess.run([sys.executable, str(HERE / suite)], capture_output=True, text=True)
    tail = [ln for ln in result.stdout.splitlines() if "passed," in ln]
    print(tail[-1] if tail else result.stdout[-400:] or result.stderr[-400:])
    if result.returncode != 0:
        failed.append(suite)
        print(result.stdout[-2000:])

print()
if failed:
    print(f"\033[31mFAILED: {', '.join(failed)}\033[0m\n")
    sys.exit(1)
print(f"\033[32mall {len(SUITES)} suites passed\033[0m\n")
