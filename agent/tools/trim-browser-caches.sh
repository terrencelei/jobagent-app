#!/bin/sh
# Empty Chrome's rebuildable caches in the saved browser profiles under private/ (Workday tenants,
# "Finish in my Chrome", handoff profiles). Sign-ins, cookies and site storage are kept, so nothing
# has to log in again. A profile that a running Chrome has open is skipped. Run weekly (launchd,
# see README) or by hand: tools/trim-browser-caches.sh [--dry-run]
# Why: on 2026-10-23, 4.6 GB of the 5.4 GB application-agent folder was Chrome cache.
set -eu
cd "$(dirname "$0")/.."
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
CACHES='Code Cache|Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|GraphiteDawnCache|component_crx_cache|optimization_guide_model_store|OnDeviceHeadSuggestModel|Safe Browsing'
OPEN=$(ps -axo args= | grep -o -- '--user-data-dir=[^ ]*' | sed 's/--user-data-dir=//' | sort -u || true)
freed=0; skipped=""
for profile in private/workday-profiles/* private/human-chrome private/browser-profile; do
  [ -d "$profile" ] || continue
  abs=$(cd "$profile" && pwd)
  if printf '%s\n' "$OPEN" | grep -qx -- "$abs"; then skipped="$skipped $profile"; continue; fi
  # Cache folders sit in the profile root (GrShaderCache...) and in Default/ (Code Cache, Cache...).
  find "$profile" -maxdepth 2 -type d | grep -E "/($CACHES)$" | while IFS= read -r dir; do
    if [ "$DRY" = 1 ]; then du -sk "$dir"; else rm -rf "$dir"; fi
  done
done
[ -n "$skipped" ] && echo "Skipped (Chrome has it open):$skipped"
echo "Done$([ "$DRY" = 1 ] && echo ' (dry run)'). private/ is now $(du -sh private | cut -f1)."
