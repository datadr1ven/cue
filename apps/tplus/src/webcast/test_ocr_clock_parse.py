#!/usr/bin/env python3
"""Unit tests for mission-clock string parsing (no RapidOCR / OpenCV needed)."""

from __future__ import annotations

from ocr_clock import parse_clock_info


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def test_spacex_classic() -> None:
    info = parse_clock_info(["T+00:08:11"])
    _assert(info["clockSec"] == 8 * 60 + 11, info)
    _assert(info["signSource"] == "signed", info)

    info = parse_clock_info(["T-00:01:30"])
    _assert(info["clockSec"] == -(1 * 60 + 30), info)


def test_nasa_bare() -> None:
    info = parse_clock_info(["HOLD", "00:04:11", "MAX Q"])
    _assert(info["clockSec"] is None, info)
    _assert(info["unsignedSec"] == 4 * 60 + 11, info)
    _assert(info["signSource"] == "bare", info)


def test_nuri_signed_mmss() -> None:
    # Live KASA OCR often drops the leading T and the hours field.
    info = parse_clock_info(["KITRI", "+17:41", "580.505KM"])
    _assert(info["clockSec"] == 17 * 60 + 41, f"expected +1061 got {info}")
    _assert(info["unsignedSec"] == 17 * 60 + 41, info)
    _assert(info["signSource"] == "signed", info)
    _assert("17:41" in (info["raw"] or ""), info)

    info = parse_clock_info(["Hanwha", "-47:38", "26.7.7"])
    _assert(info["clockSec"] == -(47 * 60 + 38), info)
    _assert(info["signSource"] == "signed", info)


def test_t_prefix_short() -> None:
    info = parse_clock_info(["T+17:41"])
    _assert(info["clockSec"] == 17 * 60 + 41, info)

    info = parse_clock_info(["T - 00 : 12 : 05"])
    _assert(info["clockSec"] == -(12 * 60 + 5), info)


def test_no_false_positive_on_telemetry() -> None:
    info = parse_clock_info(["580.505KM", "7.648KM/SEC", "NEONSAT"])
    _assert(info["clockSec"] is None, info)
    _assert(info["unsignedSec"] is None, info)


def test_nuri_circle_counter() -> None:
    # Final ~90s big circle — whole OCR lines are just the seconds.
    info = parse_clock_info(["KRI", "91", "5"])
    _assert(info["unsignedSec"] == 91, info)
    _assert(info["signSource"] == "circle", info)
    _assert(info["clockSec"] is None, info)

    info = parse_clock_info(["Hanwha", "21", "5大"])
    _assert(info["unsignedSec"] == 21, info)
    _assert(info["signSource"] == "circle", info)

    # Near T−0: prefer smallest 0..9 over stray chrome "5"
    info = parse_clock_info(["KIIRIUR", "F5", "1", "5"])
    _assert(info["unsignedSec"] == 1, info)
    _assert(info["signSource"] == "circle", info)

    info = parse_clock_info(["Hanwha", "0", "5"])
    _assert(info["unsignedSec"] == 0, info)
    _assert(info["signSource"] == "circle", info)

    # Signed T+ still wins over bare numbers
    info = parse_clock_info(["25", "Hanwha", "+00:08"])
    _assert(info["clockSec"] == 8, info)
    _assert(info["signSource"] == "signed", info)


def main() -> int:
    test_spacex_classic()
    test_nasa_bare()
    test_nuri_signed_mmss()
    test_t_prefix_short()
    test_no_false_positive_on_telemetry()
    test_nuri_circle_counter()
    print("ok — parse_clock_info cases passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
