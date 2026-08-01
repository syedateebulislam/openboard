#!/usr/bin/env python3
"""Rebuild a CSV as: every backup row, plus only genuinely new rows.

Replaces a line-based merge that compared raw text. A row re-parsed by a newer
fetcher differs textually from the backup copy of the same message, so the
text comparison kept both and duplicated it. Keying on email_uid instead means
a message already present in the backup is never added twice, whatever its
values now look like.

Rows in the backup are preserved exactly, including any duplication that was
already there (several CSVs legitimately carry one row per line item).

Usage: python dedupe_merge.py <backup.csv> <current.csv>
"""

import csv
import json
import os
import sys


def read(path):
    if not os.path.exists(path):
        return [], []
    with open(path, "r", encoding="utf-8", newline="") as handle:
        lines = handle.read().splitlines(keepends=True)
    if not lines:
        return [], []
    header = next(csv.reader([lines[0]]), [])
    return header, lines


def uid_of(line, index):
    fields = next(csv.reader([line]), [])
    return fields[index].strip() if len(fields) > index else ""


def main() -> int:
    backup_path, current_path = sys.argv[1], sys.argv[2]

    header, backup_lines = read(backup_path)
    _, current_lines = read(current_path)
    if not backup_lines:
        print(json.dumps({"error": "backup missing"}))
        return 1
    if "email_uid" not in header:
        print(json.dumps({"error": "no email_uid column"}))
        return 1

    index = header.index("email_uid")
    backup_body = backup_lines[1:]
    current_body = current_lines[1:] if current_lines else []

    known = {uid_of(line, index) for line in backup_body if line.strip()}
    added = [
        line
        for line in current_body
        if line.strip() and uid_of(line, index) and uid_of(line, index) not in known
    ]

    merged = [backup_lines[0]] + backup_body + added
    with open(current_path, "w", encoding="utf-8", newline="") as handle:
        handle.writelines(merged)

    print(json.dumps({"fromBackup": len(backup_body), "newRows": len(added), "total": len(merged) - 1}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
