#!/bin/sh
# Name: Nightstand
# Author: Nightstand
# DontUseFBInk
# Tap in the library: (re)starts the daemon, turns "Use stock home" off,
# clears a watchdog shutdown, and opens Nightstand.
NS=/mnt/us/nightstand
mkdir -p $NS/state
rm -f /tmp/nightstand-stock $NS/state/disabled
echo 0 > $NS/state/fails 2>/dev/null
pid=$(cat /tmp/nightstand-daemon.pid 2>/dev/null)
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    nohup sh $NS/bin/daemon.sh >/dev/null 2>&1 &
fi
sleep 1
lipc-set-prop com.lab126.appmgrd start app://com.nightstand.app
