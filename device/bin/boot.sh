#!/bin/sh
# Run at boot by /etc/upstart/nightstand.conf. Waits for the app manager,
# then starts SSH (key only, port 2223) and the Nightstand daemon.
NS=/mnt/us/nightstand
[ -f /mnt/us/NIGHTSTAND_OFF ] && exit 0
i=0
until lipc-get-prop com.lab126.appmgrd activeApp >/dev/null 2>&1 || [ $i -ge 120 ]; do sleep 1; i=$((i + 1)); done

# SSH for development (key login only).
if [ -x $NS/ssh/dropbear ] && [ ! -f /tmp/dropbear_ns.pid ]; then
    iptables -C INPUT -p tcp --dport 2223 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 2223 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
    iptables -C OUTPUT -p tcp --sport 2223 -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp --sport 2223 -m conntrack --ctstate ESTABLISHED -j ACCEPT
    (cd $NS/ssh && ./dropbear -E -R -s -p 2223 -P /tmp/dropbear_ns.pid >/dev/null 2>&1)
fi

pid=$(cat /tmp/nightstand-daemon.pid 2>/dev/null)
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    sh $NS/bin/daemon.sh >/dev/null 2>&1 &
fi
# The stock home may already be up: open Nightstand once.
sleep 3
lipc-set-prop com.lab126.appmgrd start app://com.nightstand.app
