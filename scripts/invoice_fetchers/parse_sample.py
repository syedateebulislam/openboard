#!/usr/bin/env python3
"""Run one fetcher's parse() over a saved sample and report what it extracted.

Not a fetcher. Biller Studio uses this to grade a freshly generated script:
compiling proves the syntax and a dry run proves it connects, but neither shows
whether the regexes actually pulled values out. This calls parse() directly on
the sample the script was written from and prints the field dict as JSON, so a
fetcher that returns nothing but blanks is caught and repaired before it is
saved.

The filename deliberately does not start with "fetch_", so discoverBillers
ignores it and it never shows up as a biller.

Usage:
    python scripts/invoice_fetchers/parse_sample.py <script.py> <sample.txt> <subject>
"""

import importlib.util
import json
import sys


def main() -> int:
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: parse_sample.py <script> <sample> <subject>"}))
        return 2

    script_path, sample_path, subject = sys.argv[1], sys.argv[2], sys.argv[3]

    spec = importlib.util.spec_from_file_location("generated_fetcher", script_path)
    if spec is None or spec.loader is None:
        print(json.dumps({"error": f"could not load {script_path}"}))
        return 1

    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 - reported as JSON for the UI
        print(json.dumps({"error": f"import failed: {type(exc).__name__}: {exc}"}))
        return 1

    if not hasattr(module, "parse"):
        print(json.dumps({"error": "the script defines no parse()"}))
        return 1

    try:
        with open(sample_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"could not read sample: {exc}"}))
        return 1

    try:
        fields = module.parse(text, subject)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"parse() raised: {type(exc).__name__}: {exc}"}))
        return 1

    if not isinstance(fields, dict):
        print(json.dumps({"error": f"parse() returned {type(fields).__name__}, expected dict"}))
        return 1

    # Values may be floats or strings; JSON handles both. stdout is the
    # machine-readable channel, so nothing else may be printed here.
    print(json.dumps({"fields": fields}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
