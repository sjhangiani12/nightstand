#!/bin/sh
# Push app/ to the Kindle, restart Nightstand, and save a screenshot.
# Usage: tools/deploy.sh [view]   (view = home | tonight | alarm | goodnight)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/private/config/tools.env" ] && . "$ROOT/private/config/tools.env"
KINDLE="${KINDLE:?Set KINDLE to the Kindle IP address, or put KINDLE=... in private/config/tools.env}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 -p 2223 root@$KINDLE"
VIEW="${1:-home}"
A=com.nightstand.app
COPYFILE_DISABLE=1 tar -C "$ROOT/app" -czf - . | $SSH "
  T=/var/local/mesquite/$A
  mkdir -p \$T && tar -C \$T -xzf -
  printf 'var NS_START = \"%s\";\n' '$VIEW' > \$T/js/start.js
  date +%s > \$T/js/build.txt
  # The app reloads itself within 15 s when build.txt changes (no app restart,
  # which can trigger a system 'Application Error' dialog).
  [ \"\$(lipc-get-prop com.lab126.appmgrd activeApp)\" = $A ] || lipc-set-prop com.lab126.appmgrd start 'app://$A'"
sleep 20
"$ROOT/tools/shot.sh" "$ROOT/shots/device-$VIEW.png"
# Leave the device opening on Home next time (the view above was only for the screenshot).
$SSH "echo 'var NS_START = \"\";' > /var/local/mesquite/$A/js/start.js"
