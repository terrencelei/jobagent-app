#!/bin/sh
# Resume only the reviewed package saved by the approval portal. Never delete job state.
set -eu
[ "$#" -gt 0 ] || { echo 'Usage: tools/finish-handoff.sh JOB_ID [JOB_ID...]' >&2; exit 2; }
cd "$(dirname "$0")/.."
for JOB in "$@"; do
  case "$JOB" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid job ID' >&2; exit 2;; esac
  RUN="private/approval-portal/runs/$JOB"
  [ -f "$RUN/plan.json" ] || { echo "No reviewed portal package for $JOB; use handoff-approved.mjs with explicit paths." >&2; exit 1; }
  node tools/handoff-approved.mjs "$RUN/jobs.json" "$RUN/profile.json" "$JOB" "$RUN/plan.json"
done
