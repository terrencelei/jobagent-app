#!/bin/sh
# Work a list of staged jobs one at a time: fill, verify, submit, and wait for the emailed code
# that the operator drops into state/<job>.code. One in flight at a time, so the newest code in
# the mailbox always belongs to the job that is waiting.
set -e
JOBS="$1"; shift
cd "$(dirname "$0")/.."
for JOB in "$@"; do
  echo "=== $JOB $(date -u +%H:%M:%S)"
  rm -f "state/$JOB.json" "state/$JOB.code"
  npm run agent -- prepare "$JOBS" private/profile.json "$JOB" "private/plan-$JOB.json" 2>&1 | tail -1 || { echo "$JOB: prepare failed"; continue; }
  npm run agent -- approve "$JOBS" private/profile.json "$JOB" "private/plan-$JOB.json" 2>&1 | tail -1 || continue
  npm run agent -- submit  "$JOBS" private/profile.json "$JOB" "private/plan-$JOB.json" 2>&1 | tail -2 || echo "$JOB: submit ended with an error"
done
echo "=== batch done $(date -u +%H:%M:%S)"
