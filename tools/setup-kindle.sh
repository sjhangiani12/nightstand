#!/bin/sh
# First-time install of Nightstand on a jailbroken Kindle, from your computer.
#
# Before you run it:
#   1. Jailbreak the Kindle and install KOReader with its SSH plugin.
#   2. Put your public key in koreader/settings/SSH/authorized_keys on the Kindle (USB).
#   3. In KOReader: Tools → Network → SSH server → Start (port 2222).
#   4. Fill in private/config/ (copy private.example/config/ and edit it).
#
# Usage: KINDLE=<ip> tools/setup-kindle.sh [--boot]
#   --boot also installs the start-at-boot job (/etc/upstart/nightstand.conf).
#
# After this, the Kindle runs its own SSH server on port 2223, and the other
# tools (deploy.sh, shot.sh, install-device.sh) use that port.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/private/config/tools.env" ] && . "$ROOT/private/config/tools.env"
KINDLE="${KINDLE:?Set KINDLE to the Kindle IP address, or put KINDLE=... in private/config/tools.env}"
PORT="${PORT:-2222}"
A=com.nightstand.app
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -p $PORT root@$KINDLE"

[ -f "$ROOT/private/config/server.env" ] || { echo "Missing private/config/server.env (see private.example/)"; exit 1; }

echo "1/6  Own SSH server (dropbear on port 2223, key login only)"
$SSH '
  set -e
  D=/mnt/us/nightstand/ssh; mkdir -p $D/settings/SSH
  cp /mnt/us/koreader/dropbear $D/dropbear; chmod +x $D/dropbear
  cp /mnt/us/koreader/settings/SSH/authorized_keys $D/settings/SSH/authorized_keys'

echo "2/6  Device scripts and lock screen"
COPYFILE_DISABLE=1 tar -C "$ROOT/device" -czf - . | $SSH '
  set -e; mkdir -p /mnt/us/nightstand && cd /mnt/us/nightstand && tar -xzf -
  mv -f Nightstand.sh /mnt/us/documents/Nightstand.sh
  chmod +x bin/*.sh /mnt/us/documents/Nightstand.sh'

echo "3/6  Config"
COPYFILE_DISABLE=1 tar -C "$ROOT/private/config" --exclude courier.env --exclude tools.env -czf - . | $SSH '
  mkdir -p /mnt/us/nightstand/config && tar -C /mnt/us/nightstand/config -xzf -'

echo "4/6  App files and registration"
COPYFILE_DISABLE=1 tar -C "$ROOT/app" -czf - . | $SSH "
  set -e
  T=/var/local/mesquite/$A; rm -rf \$T; mkdir -p \$T; tar -C \$T -xzf -
  echo 'var NS_START = \"\";' > \$T/js/start.js; date +%s > \$T/js/build.txt
  sqlite3 /var/local/appreg.db \"
    INSERT OR IGNORE INTO interfaces(interface) VALUES('application');
    INSERT OR IGNORE INTO handlerIds(handlerId) VALUES('$A');
    INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$A','lipcId','$A');
    INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$A','command','/usr/bin/mesquite -l $A -c file://\$T/');
    INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$A','supportedOrientation','U');
    INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$A','default-chrome-style','NH');
    INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$A','keepLoaded','true');\""

if [ "$1" = "--boot" ]; then
  echo "5/6  Start at boot"
  $SSH '
    set -e
    mntroot rw >/dev/null 2>&1
    cp /mnt/us/nightstand/upstart/nightstand.conf /etc/upstart/nightstand.conf
    chown root:root /etc/upstart/nightstand.conf
    mntroot ro >/dev/null 2>&1
    echo "     installed /etc/upstart/nightstand.conf (put NIGHTSTAND_OFF on the Kindle drive to turn it off)"'
else
  echo "5/6  Start at boot: skipped (run again with --boot to add it)"
fi

echo "6/6  Start SSH on 2223, the daemon, and the app"
$SSH '
  D=/mnt/us/nightstand/ssh
  iptables -C INPUT -p tcp --dport 2223 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 2223 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
  iptables -C OUTPUT -p tcp --sport 2223 -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp --sport 2223 -m conntrack --ctstate ESTABLISHED -j ACCEPT
  [ -f /tmp/dropbear_ns.pid ] || (cd $D && setsid ./dropbear -E -R -s -p 2223 -P /tmp/dropbear_ns.pid </dev/null >/tmp/dropbear_ns.log 2>&1 &)
  setsid sh /mnt/us/documents/Nightstand.sh </dev/null >/dev/null 2>&1 &'

echo
echo "Done. Nightstand should open on the Kindle in a few seconds."
echo "From now on:  ssh -p 2223 root@$KINDLE   ·   tools/deploy.sh   ·   tools/shot.sh"
