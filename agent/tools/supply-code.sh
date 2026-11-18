#!/bin/sh
# Hand an emailed verification code to whichever application is waiting for one. Exactly one
# submission runs at a time, so the newest code in the mailbox belongs to that job.
set -e
[ -n "$1" ] || { echo "Usage: tools/supply-code.sh CODE" >&2; exit 2; }
cd "$(dirname "$0")/.."
JOB=$(grep -l '"status": "awaiting_verification_code"' state/*.json 2>/dev/null | head -1)
[ -n "$JOB" ] || { echo "Nothing is waiting for a code" >&2; exit 1; }
JOB=$(basename "$JOB" .json)
printf '%s' "$1" > "state/$JOB.code"
echo "$JOB: code supplied"
