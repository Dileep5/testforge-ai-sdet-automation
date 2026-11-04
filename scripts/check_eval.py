#!/usr/bin/env python3
"""Fail if offline evaluation results differ from the recorded baseline, in either direction."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
baseline = json.loads((ROOT / "ai/evaluation/baseline.json").read_text())
problems = []
for split in ("dev", "heldout"):
    report = json.loads((ROOT / f"reports/ai/eval-{split}.json").read_text())
    if report["provider"] != "offline-extractive":
        problems.append(f"{split}: expected the offline provider, got {report['provider']}")
    for name, expected in baseline[split].items():
        metric = report["metrics"][name]
        actual = [metric["numerator"], metric["denominator"]]
        print(f"{split} {name}: {actual[0]}/{actual[1]} (baseline {expected[0]}/{expected[1]})")
        if actual != expected:
            problems.append(f"{split} {name}: {actual} differs from {expected}")
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
