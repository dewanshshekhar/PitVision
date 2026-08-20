"""Tests for the offline calibrator.

What is checkable here is the *branch decision* — whether the calibrator
concludes the footage is dry, wet, or spans both — because that is decidable
from clips with known properties, and it is the piece whose failure is silent.
Getting it wrong does not raise: it produces anchors that look reasonable and
put a dry track at 94 on the index.

What is not checkable here is whether the anchors are correct for a real
circuit. That needs a real circuit. The clips below are a fixture, and one of
them started out physically wrong in an instructive way — see the note in
`make_test_clips.py` about wet surfaces being *smoother*, not noisier.

    .venv/bin/python ml/tests/test_calibrate.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from make_test_clips import write_clip  # noqa: E402

import calibrate  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    if ok:
        _passed += 1
        print(f"  \033[32m✓\033[0m {name}")
    else:
        _failed += 1
        print(f"  \033[31m✗\033[0m {name}" + (f" — {detail}" if detail else ""))


def section(t: str) -> None:
    print(f"\n\033[1m{t}\033[0m")


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    write_clip(root / "dry.mp4", wet_from=None, frames=90)
    write_clip(root / "wet.mp4", wet_from=0.0, frames=90, seed=9)
    write_clip(root / "mixed.mp4", wet_from=0.5, frames=90, seed=11)

    def run(clip: str, out: str) -> dict:
        code = calibrate.main([str(root / clip), "--out", str(root / out), "--every", "3"])
        assert code == 0, f"calibrate exited {code} on {clip}"
        return json.loads((root / out).read_text())

    # ── Branch decisions ───────────────────────────────────────────────
    section("The anchoring branch follows the footage")

    dry = run("dry.mp4", "dry.json")
    check("dry footage anchors dry", dry["branch"] == "dry-anchored", dry["branch"])
    check("and reports no wet frames", dry["wet_share"] < 0.05, str(dry["wet_share"]))
    check("the wet end is derived, not measured",
          dry["wet"]["texture"] < dry["dry"]["texture"],
          f"dry {dry['dry']['texture']:.0f} → wet {dry['wet']['texture']:.0f}")

    wet = run("wet.mp4", "wet.json")
    check("soaked footage anchors wet", wet["branch"] == "wet-anchored", wet["branch"])
    check("and says the dry end was derived backwards",
          "reverse of the usual direction" in wet["note"], wet["note"][:80])

    mixed = run("mixed.mp4", "mixed.json")
    check("footage spanning both states measures both ends",
          mixed["branch"] == "measured-both-ends", mixed["branch"])
    check("with a real wet share", mixed["wet_share"] > 0.30, str(mixed["wet_share"]))

    # ── The physics the index depends on ───────────────────────────────
    section("The anchors point the way water actually behaves")
    for name, cal in (("dry", dry), ("wet", wet), ("mixed", mixed)):
        d, w = cal["dry"], cal["wet"]
        check(f"[{name}] wet is smoother than dry", w["texture"] < d["texture"],
              f"{d['texture']:.0f} → {w['texture']:.0f}")
        check(f"[{name}] wet is darker than dry", w["darkness"] > d["darkness"],
              f"{d['darkness']:.3f} → {w['darkness']:.3f}")
        check(f"[{name}] wet is more specular than dry", w["specular"] >= d["specular"],
              f"{d['specular']:.3f} → {w['specular']:.3f}")

    # ── The output contract ────────────────────────────────────────────
    section("The calibration file carries what the app needs")
    check("all four signals are anchored at both ends",
          set(dry["dry"]) == set(dry["wet"]) == {"glare", "texture", "darkness", "specular"})
    check("tracer thresholds are emitted",
          {"maxSat", "lumaTolerance"} <= set(dry["tracer"]), str(list(dry["tracer"])))
    check("maxSat stays below where vegetation starts", dry["tracer"]["maxSat"] <= 0.42,
          str(dry["tracer"]["maxSat"]))
    check("the observed ranges are reported, not just the anchors",
          set(dry["spread"]) == {"glare", "texture", "darkness", "specular"})
    check("provenance is recorded",
          bool(dry["clips"]) and bool(dry["generated_at"]) and bool(dry["road_source"]))
    check("the road-found share is reported so a biased sample is visible",
          0.0 <= dry["road_found_share"] <= 1.0, str(dry["road_found_share"]))
    check("a human-readable note explains the branch", len(dry["note"]) > 40)

    # ── Refusal ────────────────────────────────────────────────────────
    section("It refuses footage it cannot calibrate from")
    import cv2
    import numpy as np

    blank = root / "blank.mp4"
    writer = cv2.VideoWriter(str(blank), cv2.VideoWriter_fourcc(*"mp4v"), 25, (320, 180))
    for _ in range(60):
        writer.write(np.full((180, 320, 3), (46, 106, 56), dtype=np.uint8))  # all grass
    writer.release()

    code = calibrate.main([str(blank), "--out", str(root / "blank.json"), "--every", "2"])
    check("a clip with no road exits non-zero rather than emitting anchors", code != 0, str(code))
    check("and writes no calibration file", not (root / "blank.json").exists())

_colour = "\033[32m" if _failed == 0 else "\033[31m"
print(f"\n{_colour}{_passed} passed, {_failed} failed\033[0m\n")
sys.exit(1 if _failed else 0)
