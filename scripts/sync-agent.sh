#!/bin/sh
# Dev loop for the Mac daemon: copy this checkout's agent adapters over the
# installed ones and restart the service, without cutting a release.
# A later `brew upgrade tagmails` replaces them with the released build.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
dest=$(tagmails status | sed -n 's/^ *Adapters *//p')
[ -d "$dest" ] || { echo "Could not find the installed adapters (tagmails status)." >&2; exit 1; }
for file in "$root"/agent/*.mjs; do
  case "$file" in *.test.mjs) continue ;; esac
  cp "$file" "$dest/"
done
case "$(uname)" in
  Darwin) launchctl kickstart -k "gui/$(id -u)/com.tagmails.daemon" ;;
  *) systemctl --user restart tagmails.service ;;
esac
sleep 2
tagmails status | sed -n '1,4p'
