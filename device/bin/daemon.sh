#!/bin/sh
# Nightstand daemon: the local helper and the home watcher.
# Escapes back to the stock home:
#   1. /tmp/nightstand-stock      "Use stock home" in Tonight (until restart)
#   2. $NS/state/disabled         set by the watchdog after 3 failed starts
#   3. /mnt/us/NIGHTSTAND_OFF     kill switch: put this file on over USB
NS=/mnt/us/nightstand
APP=com.nightstand.app
LOG=/tmp/nightstand.log
mkdir -p $NS/state
echo $$ > /tmp/nightstand-daemon.pid

# "Use stock home" is a one-time pass: it lets the stock home through for
# 15 s (it fires twice), then the next Home press brings Nightstand back.
stock_pass() {
    [ -f /tmp/nightstand-stock ] || return 1
    t=$(cat /tmp/nightstand-stock 2>/dev/null); now=$(date +%s)
    if [ -n "$t" ] && [ $((now - t)) -lt 15 ]; then return 0; fi
    rm -f /tmp/nightstand-stock; return 1
}
off() { [ -f /mnt/us/NIGHTSTAND_OFF ] || [ -f $NS/state/disabled ]; }

log() { echo "$(date '+%H:%M:%S') $*" >> $LOG; }

# Local helper on 127.0.0.1:8765 (no python on the Kindle; busybox tcpsvd).
if ! netstat -ln 2>/dev/null | grep -q '127.0.0.1:8765'; then
    tcpsvd -E 127.0.0.1 8765 sh $NS/bin/helper.sh >/dev/null 2>&1 &
    echo $! > /tmp/nightstand-helper.pid
fi

# Lock screen: when the Kindle goes to sleep it draws its own screensaver
# (a book cover). Wait for that, then draw ours on top. E-ink keeps the
# image with no power. After "Lights out" we redraw the Goodnight screen
# (saved by helper.sh /sleep) instead of the photo.
FBINK=/mnt/us/libkh/bin/fbink; [ -x $FBINK ] || FBINK=/mnt/us/koreader/fbink
# Special Offers Kindles use the "ad_screensaver" module, which shows an ad
# with "swipe to unlock" on every wake. Swap in the plain module, so a wake
# goes straight to Nightstand. Done once, when the daemon starts: loading a
# module shows the screensaver at once, so wake the Kindle after. A restart undoes it.
plain_screensaver() {
    # Once per boot: a module load shows the screensaver, so never repeat it
    # on a daemon restart. /tmp is cleared at boot.
    [ -f /tmp/nightstand-plain-ss ] && return 0
    touch /tmp/nightstand-plain-ss
    before=$(lipc-get-prop com.lab126.powerd state 2>/dev/null)
    lipc-set-prop com.lab126.blanket unload ad_screensaver 2>/dev/null
    lipc-set-prop com.lab126.blanket load screensaver 2>/dev/null
    sleep 2
    if [ "$before" = "active" ] && [ "$(lipc-get-prop com.lab126.powerd state 2>/dev/null)" = "screenSaver" ]; then
        lipc-set-prop com.lab126.powerd powerButton 1   # the load put it to sleep: wake it
    fi
    log "lock: plain screensaver module"
}

# The plain module draws a picture from /usr/share/blanket/screensaver
# (Amazon's water bottles, pencils...). Bind-mount a folder that holds only
# our photo over it, so the module draws ours. Nothing on the system
# partition changes, and a restart undoes it.
SSDIR=/usr/share/blanket/screensaver
photo_screensaver() {
    mkdir -p $NS/ss
    cp -f $NS/lockscreen.png $NS/ss/bg_ss00.png
    grep -q " $SSDIR " /proc/mounts || mount --bind $NS/ss $SSDIR
    log "lock: photo folder mounted"
}

if ! off; then
    photo_screensaver
    plain_screensaver
fi

lockscreen() {
    lipc-wait-event -m com.lab126.powerd goingToScreenSaver,outOfScreenSaver | while read -r ev rest; do
        case "$ev" in
            goingToScreenSaver)
                # The module draws the photo itself. After "Lights out",
                # redraw the saved Goodnight screen over it instead.
                if [ -f /tmp/nightstand-goodnight ] && [ -f /tmp/nightstand-goodnight.raw ]; then
                    sleep 3
                    dd if=/tmp/nightstand-goodnight.raw of=/dev/fb0 bs=1088 count=1448 2>/dev/null
                    $FBINK -q -f -s top=0,left=0,width=1072,height=1448
                    log "sleep: goodnight screen"
                else
                    log "sleep: photo (module)"
                fi
                ;;
            outOfScreenSaver)
                rm -f /tmp/nightstand-goodnight
                # Remove alarms that have rung; arm ones that are now within a week.
                ( sleep 8; curl -s -m 30 http://127.0.0.1:8765/alarm/list >/dev/null ) &
                # Once the app has repainted, flash the panel to clear ghosting.
                ( sleep 3; $FBINK -q -f -s top=0,left=0,width=1072,height=1448 ) &
                log "woke"
                ;;
        esac
    done
}
lockscreen &

# Escape 2: count starts that fail; turn off after 3 in a row.
check_started() {
    sleep 15
    off && return   # turned off meanwhile: not a failure
    [ -f /tmp/nightstand-stock ] && return
    if [ "$(lipc-get-prop com.lab126.appmgrd activeApp 2>/dev/null)" = "$APP" ]; then
        echo 0 > $NS/state/fails
    else
        n=$(( $(cat $NS/state/fails 2>/dev/null || echo 0) + 1 ))
        echo $n > $NS/state/fails
        log "start failed ($n)"
        if [ $n -ge 3 ]; then
            touch $NS/state/disabled
            log "disabled after 3 failed starts; opening stock home"
            lipc-set-prop com.lab126.appmgrd start "app://com.lab126.KPPMainApp?view=KPP_HOME"
        fi
    fi
}

log "daemon up"
# Event format: historyChange "<from>" "<to>" "<view>" ...  Match on <to>.
LAST=0
lipc-wait-event -m com.lab126.appmgrd historyChange | while read -r line; do
    to=$(printf '%s' "$line" | awk -F'"' '{print $4}')
    case "$to" in
        *"view=KPP_HOME"*) ;;
        *) continue ;;
    esac
    if off; then log "home: stock (Nightstand off)"; continue; fi
    if stock_pass; then log "home: stock (one-time pass)"; continue; fi
    [ "$(lipc-get-prop com.lab126.appmgrd activeApp 2>/dev/null)" = "$APP" ] && continue
    now=$(date +%s)
    # Loop breaker: never redirect more than once every 5 seconds.
    if [ $((now - LAST)) -lt 5 ]; then log "home: skipped (too soon)"; continue; fi
    LAST=$now
    log "home -> nightstand"
    lipc-set-prop com.lab126.appmgrd start "app://$APP"
    check_started &
done
