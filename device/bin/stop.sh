#!/bin/sh
# Stop the Nightstand daemon and its listeners (by pid, never by pattern).
kill "$(cat /tmp/nightstand-daemon.pid 2>/dev/null)" 2>/dev/null
for p in $(pidof lipc-wait-event); do
    case "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)" in
        *com.lab126.appmgrd*historyChange*|*com.lab126.powerd*goingToScreenSaver*) kill "$p" ;;
    esac
done
kill "$(cat /tmp/nightstand-helper.pid 2>/dev/null)" 2>/dev/null
rm -f /tmp/nightstand-daemon.pid /tmp/nightstand-helper.pid
# The lock screen photo mount stays: a daemon restart must not change the lock screen.
# To remove it: umount /usr/share/blanket/screensaver (or restart the Kindle).
