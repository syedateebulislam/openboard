#!/usr/bin/env python3
"""CSV surgery for the round-trip verification.

Uses the same csv module and dialect as the fetchers, so quoting and embedded
commas behave identically — a hand-rolled splitter would corrupt rows that
contain addresses or item lists.

Subcommands:
    snip   <csv> <state.json>   remove the newest row + its UID, print it as JSON
    verify <csv> <expected.json>  confirm that row is back and identical
"""

import csv
import json
import os
import sys


def read_rows(path):
    with open(path, "r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return reader.fieldnames or [], list(reader)


def write_rows(path, fieldnames, rows):
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def snip(csv_path, state_path):
    """Remove the newest row this account can actually re-fetch.

    Line-based rather than DictWriter-based: some CSVs carry rows with more
    fields than the header (urban_company has three), and a Dict round trip
    raises on those — which truncated the file on the first attempt.

    The candidate must appear in state.json. A CSV can hold rows fetched by a
    different Gmail account, and those UIDs do not exist in this mailbox, so
    snipping one would delete a row that can never come back.
    """
    if not os.path.exists(csv_path):
        return {"error": "csv not found"}

    with open(csv_path, "r", encoding="utf-8", newline="") as handle:
        lines = handle.read().splitlines(keepends=True)
    if len(lines) < 2:
        return {"error": "csv has no data rows"}

    header = next(csv.reader([lines[0]]))
    try:
        uid_index = header.index("email_uid")
        date_index = header.index("email_date")
    except ValueError:
        return {"error": "csv has no email_uid column"}

    known = set()
    if os.path.exists(state_path):
        with open(state_path, "r", encoding="utf-8") as handle:
            known = set(json.load(handle))
    if not known:
        return {"error": "no state.json — nothing this account has fetched"}

    best_index = None
    best_uid = -1
    for index in range(1, len(lines)):
        if not lines[index].strip():
            continue
        fields = next(csv.reader([lines[index]]), [])
        if len(fields) <= uid_index:
            continue
        uid = fields[uid_index].strip()
        if uid not in known:
            continue  # belongs to another mailbox; not re-fetchable here
        try:
            value = int(uid)
        except ValueError:
            continue
        if value > best_uid:
            best_uid, best_index = value, index

    if best_index is None:
        return {"error": "no row in this CSV was fetched by the configured account"}

    target_line = lines[best_index]
    fields = next(csv.reader([target_line]))
    uid = fields[uid_index].strip()

    remaining = lines[:best_index] + lines[best_index + 1 :]
    with open(csv_path, "w", encoding="utf-8", newline="") as handle:
        handle.writelines(remaining)

    uids = [u for u in known if u != uid]
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(sorted(set(uids), key=lambda x: int(x)), handle, indent=2)

    return {
        "uid": uid,
        "emailDate": fields[date_index] if len(fields) > date_index else "",
        "rowsBefore": len(lines) - 1,
        "rowsAfter": len(remaining) - 1,
        "removedFromState": True,
        "row": dict(zip(header, fields)),
    }


def verify(csv_path, expected_path):
    with open(expected_path, "r", encoding="utf-8") as handle:
        expected = json.load(handle)

    _, rows = read_rows(csv_path)
    uid = str(expected["uid"])
    matches = [r for r in rows if str(r.get("email_uid")) == uid]

    if not matches:
        return {"restored": False, "reason": "no row with that UID came back", "rows": len(rows)}

    actual = matches[0]
    wanted = expected["row"]
    differing = {
        key: {"before": wanted.get(key), "after": actual.get(key)}
        for key in wanted
        if (wanted.get(key) or "") != (actual.get(key) or "")
    }

    return {
        "restored": True,
        "identical": not differing,
        "differing": differing,
        "rows": len(rows),
        "fields": len(wanted),
    }


def main() -> int:
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: roundtrip_csv.py <snip|verify> <csv> <arg>"}))
        return 2
    command = sys.argv[1]
    try:
        if command == "snip":
            print(json.dumps(snip(sys.argv[2], sys.argv[3])))
        elif command == "verify":
            print(json.dumps(verify(sys.argv[2], sys.argv[3])))
        else:
            print(json.dumps({"error": f"unknown command {command}"}))
            return 2
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
