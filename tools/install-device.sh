#!/bin/sh
# Copy device/ to the Kindle (/mnt/us/nightstand + the library launcher).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/private/config/tools.env" ] && . "$ROOT/private/config/tools.env"
KINDLE="${KINDLE:?Set KINDLE to the Kindle IP address, or put KINDLE=... in private/config/tools.env}"
COPYFILE_DISABLE=1 tar -C "$ROOT/device" -czf - . | ssh -o BatchMode=yes -p 2223 root@$KINDLE '
  mkdir -p /mnt/us/nightstand && cd /mnt/us/nightstand && tar -xzf - &&
  mv -f Nightstand.sh /mnt/us/documents/Nightstand.sh && chmod +x bin/*.sh /mnt/us/documents/Nightstand.sh &&
  ls -la /mnt/us/nightstand /mnt/us/nightstand/bin'
