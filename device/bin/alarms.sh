# Sourced by helper.sh. Alarms with a real date on Sonos.
# Sonos alarms have no date: only a time and a recurrence. So:
#   - when the time's next occurrence IS the target day -> Recurrence ONCE
#   - else, within 6 days -> ON_<weekday> (deleted after it rings)
#   - later -> kept here as "pending", armed once it is within 6 days
# List file: $STATE/alarms.txt, one alarm per line: "YYYY-MM-DD HH:MM ID" (ID "-" = pending)
AL=$STATE/alarms.txt
touch $AL
# Alarm volume (0-100 on Sonos). Saved from the Alarms screen; default 10.
SONOS_VOLUME=$(cat $STATE/alarm-volume 2>/dev/null)
case "$SONOS_VOLUME" in ''|*[!0-9]*) SONOS_VOLUME=10 ;; esac

# New volume: save it and re-create every armed alarm with it.
alarm_set_volume() {
    v=$1
    case "$v" in ''|*[!0-9]*) return ;; esac
    [ "$v" -lt 1 ] && v=1; [ "$v" -gt 60 ] && v=60
    echo "$v" > $STATE/alarm-volume; SONOS_VOLUME=$v
    [ -s $AL ] || return 0
    tmp=$AL.tmp; : > $tmp
    while read -r d t id; do
        [ -n "$d" ] || continue
        if [ "$id" != "-" ]; then sonos_destroy "$id"; id=$(arm $d $t); [ "$id" = "x" ] && continue; fi
        echo "$d $t $id" >> $tmp
    done < $AL
    mv $tmp $AL
}

# Home time (the Kindle's own zone is wrong): UTC + the server's offset.
home_off() {
    o=$(sed -n 's/.*"tzOffsetMinutes":\(-\{0,1\}[0-9]*\).*/\1/p' $STATE/tonight.json 2>/dev/null)
    echo "${o:--300}"
}
home_epoch() { echo $(( $(date -u +%s) + $(home_off) * 60 )); }   # "local" seconds, read as UTC
day_epoch() { date -u -d "$1 00:00:00" +%s 2>/dev/null; }          # YYYY-MM-DD -> UTC midnight

# "<days ahead> <weekday>" of a date, from home time; empty if invalid.
days_ahead() {
    now=$(home_epoch)
    today=$(date -u -d @$now +%Y-%m-%d)
    t=$(day_epoch "$1") || return
    [ -n "$t" ] || return
    echo "$(( (t - $(day_epoch $today)) / 86400 )) $(date -u -d @$t +%w)"
}
now_hm() { date -u -d @$(home_epoch) +%H:%M; }

sonos_create() { # recurrence HH:MM -> prints new ID
    r=$(soap CreateAlarm "$(alarm_args_r "$2:00" 1 "$1")")
    printf '%s' "$r" | sed -n 's/.*<AssignedID>\([0-9]*\)<\/AssignedID>.*/\1/p'
}
sonos_destroy() { [ "$1" = "-" ] || soap DestroyAlarm "<ID>$1</ID>" >/dev/null; }
alarm_args_r() { # HH:MM:SS enabled recurrence
    printf '<StartLocalTime>%s</StartLocalTime><Duration>01:00:00</Duration><Recurrence>%s</Recurrence><Enabled>%s</Enabled><RoomUUID>%s</RoomUUID><ProgramURI>%s</ProgramURI><ProgramMetaData>%s</ProgramMetaData><PlayMode>NORMAL</PlayMode><Volume>%s</Volume><IncludeLinkedZones>0</IncludeLinkedZones>' \
        "$1" "$3" "$2" "$SONOS_ROOM" "$(cat $CFG/sonos-uri.txt)" "$(cat $CFG/sonos-meta.txt)" "$SONOS_VOLUME"
}

# Arm one alarm on Sonos if possible. Prints the ID, or "-" (pending), or "x" (past).
arm() { # date time
    set -- $1 $2 $(days_ahead $1)
    d=$3; wd=$4
    [ -n "$d" ] || { echo x; return; }
    now=$(now_hm)
    if [ "$d" -lt 0 ] || { [ "$d" -eq 0 ] && ! [ "$2" \> "$now" ]; }; then echo x; return; fi
    if { [ "$d" -eq 0 ] && [ "$2" \> "$now" ]; } || { [ "$d" -eq 1 ] && ! [ "$2" \> "$now" ]; }; then
        rec=ONCE
    elif [ "$d" -le 6 ]; then
        rec=ON_$wd
    else
        echo -; return
    fi
    id=$(sonos_create $rec $2)
    echo "${id:--}"
}

# Drop alarms that have rung; arm pending ones that are now close enough.
alarm_sync() {
    [ -s $AL ] || return 0
    now=$(now_hm); tmp=$AL.tmp; : > $tmp
    while read -r d t id; do
        [ -n "$d" ] || continue
        set -- $(days_ahead $d)
        if [ -z "$1" ] || [ "$1" -lt 0 ] || { [ "$1" -eq 0 ] && ! [ "$t" \> "$now" ]; }; then
            sonos_destroy "$id"; continue          # it has rung (or is invalid)
        fi
        if [ "$id" = "-" ] && [ "$1" -le 6 ]; then id=$(arm $d $t); fi
        echo "$d $t $id" >> $tmp
    done < $AL
    sort $tmp > $AL; rm -f $tmp
}

alarm_add() { # date time [replace]
    case "$1" in [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]) ;; *) echo "error=bad-date"; return ;; esac
    case "$2" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "error=bad-time"; return ;; esac
    if [ "$3" = "1" ]; then alarm_del_date "$1"; fi
    grep -q "^$1 $2 " $AL && { echo "ok"; return; }
    id=$(arm $1 $2)
    [ "$id" = "x" ] && { echo "error=past"; return; }
    echo "$1 $2 $id" >> $AL; sort -o $AL $AL
    echo "ok"
}
alarm_del() { # date time
    line=$(grep "^$1 $2 " $AL | head -1)
    [ -n "$line" ] || return
    sonos_destroy "$(echo $line | cut -d' ' -f3)"
    grep -v "^$1 $2 " $AL > $AL.tmp; mv $AL.tmp $AL
}
alarm_del_date() { # date: every alarm on that day
    grep "^$1 " $AL | while read -r d t id; do sonos_destroy "$id"; done
    grep -v "^$1 " $AL > $AL.tmp; mv $AL.tmp $AL
}
# One-time cleanup of the old single-alarm version.
if [ -f $STATE/sonos-alarm-id ]; then sonos_destroy "$(cat $STATE/sonos-alarm-id)"; rm -f $STATE/sonos-alarm-id; fi
