#!/bin/sh
# Optional attachment to a browser explicitly opened for debugging. Never copy real profiles.
set -eu
PORT=9222
[ "$#" -gt 0 ] || { echo 'Usage: tools/attach-chrome.sh JOB_ID [JOB_ID...]' >&2; exit 2; }
cd "$(dirname "$0")/.."
if ! curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo 'No explicitly debug-enabled browser is available.' >&2
  echo 'Chrome 136+ ignores remote debugging on its default profile.' >&2
  echo 'Use tools/finish-handoff.sh for a visible, separate Chrome session.' >&2
  echo 'This does not guarantee a CAPTCHA or spam check will accept the application.' >&2
  exit 1
fi
APPLICATION_AGENT_CDP="http://127.0.0.1:$PORT" tools/finish-handoff.sh "$@"
