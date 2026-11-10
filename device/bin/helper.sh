#!/bin/sh
# Nightstand local helper. tcpsvd runs this once per connection on
# 127.0.0.1:8765. It reads one HTTP request line and writes one response.
NS=/mnt/us/nightstand
CFG=$NS/config
STATE=$NS/state
mkdir -p $STATE

respond() {
    body="$1"
    type="${2:-text/plain}"
    printf 'HTTP/1.0 200 OK\r\nContent-Type: %s\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
        "$type" "$(printf '%s' "$body" | wc -c | tr -d ' ')" "$body"
}

read -r method target proto
target=$(printf '%s' "$target" | tr -d '\r')
while read -r h; do h=$(printf '%s' "$h" | tr -d '\r'); [ -z "$h" ] && break; done
path=${target%%\?*}
query=""
case "$target" in *\?*) query=${target#*\?} ;; esac
q() { printf '%s' "$query" | tr '&' '\n' | sed -n "s/^$1=//p" | head -1; }

# ---------- Hue (local bridge) ----------
hue_put() { # lamp-id json
    curl -s -m 5 -X PUT -d "$2" "http://$HUE_BRIDGE/api/$HUE_USER/lights/$1/state"
}

# ---------- Sonos alarm (local UPnP AlarmClock service) ----------
soap() { # action inner-xml
    curl -s -m 6 -X POST "http://$SONOS_IP:1400/AlarmClock/Control" \
        -H 'Content-Type: text/xml; charset="utf-8"' \
        -H "SOAPACTION: \"urn:schemas-upnp-org:service:AlarmClock:1#$1\"" \
        -d "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:$1 xmlns:u=\"urn:schemas-upnp-org:service:AlarmClock:1\">$2</u:$1></s:Body></s:Envelope>"
}
alarm_args() { # HH:MM:SS enabled
    printf '<StartLocalTime>%s</StartLocalTime><Duration>01:00:00</Duration><Recurrence>ONCE</Recurrence><Enabled>%s</Enabled><RoomUUID>%s</RoomUUID><ProgramURI>%s</ProgramURI><ProgramMetaData>%s</ProgramMetaData><PlayMode>NORMAL</PlayMode><Volume>%s</Volume><IncludeLinkedZones>0</IncludeLinkedZones>' \
        "$1" "$2" "$SONOS_ROOM" "$(cat $CFG/sonos-uri.txt)" "$(cat $CFG/sonos-meta.txt)" "$SONOS_VOLUME"
}
# Our alarm's line from ListAlarms, or nothing if it is gone.
our_alarm() {
    id=$(cat $STATE/sonos-alarm-id 2>/dev/null)
    [ -n "$id" ] || return
    soap ListAlarms "" | sed 's/&lt;/</g; s/&gt;/>/g; s/&quot;/"/g' | tr '>' '\n' \
        | grep "<Alarm ID=\"$id\"" | grep "RoomUUID=\"$SONOS_ROOM\""
}
alarm_status() {
    line=$(our_alarm)
    if [ -z "$line" ]; then echo "set=0"; return; fi
    t=$(printf '%s' "$line" | sed -n 's/.*StartTime="\([0-9:]*\)".*/\1/p')
    en=$(printf '%s' "$line" | sed -n 's/.*Enabled="\([01]\)".*/\1/p')
    printf 'set=%s\ntime=%s\nid=%s\n' "$en" "$t" "$(cat $STATE/sonos-alarm-id)"
}

case "$path" in
    /jslog)
        printf '%s %s\n' "$(date +%T)" "$(q m | sed 's/%20/ /g; s/%3A/:/g; s/%2F/\//g; s/%40/@/g; s/%2C/,/g; s/%27/'"'"'/g; s/%22/"/g')" >> /tmp/nightstand-js.log
        respond "ok" ;;
    /build)
        respond "$(cat /var/local/mesquite/com.nightstand.app/js/build.txt 2>/dev/null)" ;;
    /ping)
        respond "ok" ;;
    /names)
        . $CFG/hue.env 2>/dev/null; . $CFG/sonos.env 2>/dev/null
        respond "room=${ROOM_NAME:-Bedroom}
speaker=${SPEAKER_NAME:-Bedroom}" ;;
    /status)
        respond "wifi=$(lipc-get-prop com.lab126.cmd wirelessEnable 2>/dev/null)
batt=$(lipc-get-prop com.lab126.powerd battLevel 2>/dev/null)" ;;

    /hue/lights)
        . $CFG/hue.env
        out="{"; sep=""
        for id in $HUE_LAMPS; do
            j=$(curl -s -m 4 "http://$HUE_BRIDGE/api/$HUE_USER/lights/$id")
            [ -n "$j" ] || j='{}'
            out="$out$sep\"$id\":$j"; sep=","
        done
        respond "$out}" "application/json" ;;
    /hue/set)
        . $CFG/hue.env
        id=$(q id); on=$(q on); bri=$(q bri); ct=$(q ct)
        case "$id" in ''|*[!0-9]*) respond "error=bad-id"; exit 0 ;; esac
        case "$bri" in *[!0-9]*) bri="" ;; esac
        case "$ct" in *[!0-9]*) ct="" ;; esac
        if [ "$on" = "1" ]; then
            body='"on":true'
            [ -n "$bri" ] && body="$body,\"bri\":$bri"
            [ -n "$ct" ] && body="$body,\"ct\":$ct"
            body="{$body}"
        else
            body='{"on":false}'
        fi
        respond "$(hue_put "$id" "$body")" "application/json" ;;
    /hue/off)
        . $CFG/hue.env
        # 3 s fade so the room does not snap to black.
        for id in $HUE_LAMPS; do hue_put "$id" '{"on":false,"transitiontime":30}' >/dev/null; done
        respond "ok" ;;

    /alarm/list)
        . $CFG/sonos.env; . $NS/bin/alarms.sh
        alarm_sync
        respond "$(cat $AL)" ;;
    /alarm/add)
        . $CFG/sonos.env; . $NS/bin/alarms.sh
        alarm_sync
        r=$(alarm_add "$(q d)" "$(q t)" "$(q replace)")
        respond "$r
$(cat $AL)" ;;
    /alarm/volume)
        . $CFG/sonos.env; . $NS/bin/alarms.sh
        [ -n "$(q v)" ] && alarm_set_volume "$(q v)"
        respond "volume=$SONOS_VOLUME" ;;
    /alarm/del)
        . $CFG/sonos.env; . $NS/bin/alarms.sh
        alarm_del "$(q d)" "$(q t)"
        respond "$(cat $AL)" ;;
    /alarm/get)
        . $CFG/sonos.env
        respond "$(alarm_status)" ;;
    /alarm/set)
        . $CFG/sonos.env
        t=$(q t)
        case "$t" in [0-2][0-9]:[0-5][0-9]) ;; *) respond "error=bad-time"; exit 0 ;; esac
        if [ -n "$(our_alarm)" ]; then
            r=$(soap UpdateAlarm "<ID>$(cat $STATE/sonos-alarm-id)</ID>$(alarm_args "$t:00" 1)")
        else
            r=$(soap CreateAlarm "$(alarm_args "$t:00" 1)")
            newid=$(printf '%s' "$r" | sed -n 's/.*<AssignedID>\([0-9]*\)<\/AssignedID>.*/\1/p')
            [ -n "$newid" ] && echo "$newid" > $STATE/sonos-alarm-id
        fi
        case "$r" in *Fault*) respond "error=sonos $(printf '%s' "$r" | sed -n 's/.*<errorCode>\([0-9]*\).*/\1/p')"; exit 0 ;; esac
        respond "$(alarm_status)" ;;
    /alarm/off)
        . $CFG/sonos.env
        line=$(our_alarm)
        if [ -n "$line" ]; then
            t=$(printf '%s' "$line" | sed -n 's/.*StartTime="\([0-9:]*\)".*/\1/p')
            soap UpdateAlarm "<ID>$(cat $STATE/sonos-alarm-id)</ID>$(alarm_args "$t" 0)" >/dev/null
        fi
        respond "$(alarm_status)" ;;

    /tonight)
        # Calendar + weather from the Nightstand server, cached for offline use.
        . $CFG/server.env 2>/dev/null
        j=""
        if [ -n "$SERVER_URL" ]; then
            j=$(curl -s -m 10 -H "Authorization: Bearer $SERVER_KEY" "$SERVER_URL/tonight")
        fi
        case "$j" in
            \{*) printf '%s' "$j" > $STATE/tonight.json ;;
            *) j=$(cat $STATE/tonight.json 2>/dev/null || echo '{}') ;;
        esac
        respond "$j" "application/json" ;;

    /lib/sync)
        # Pull new EPUBs from the server and unpack them for the reader.
        . $CFG/server.env 2>/dev/null
        LIB=$NS/library; mkdir -p $LIB
        j=$(curl -s -m 20 -H "Authorization: Bearer $SERVER_KEY" "$SERVER_URL/sync")
        case "$j" in
            \{*)
                printf '%s' "$j" > $STATE/library.json
                # "<id> <ready_at>" pairs; a newer ready_at means the server rebuilt it.
                printf '%s' "$j" | sed -n '/"items"/,/"archived"/p' | awk -F'"' '/"id":/ {id=$4} /"ready_at":/ {gsub(/[^0-9]/,"",$3); print id, $3}' | while read -r id ra; do
                    [ -n "$id" ] || continue
                    [ "$(cat "$LIB/$id/.ok" 2>/dev/null)" = "$ra" ] && continue
                    if curl -s -m 60 -H "Authorization: Bearer $SERVER_KEY" -o "$LIB/$id.epub" "$SERVER_URL/articles/$id/epub"; then
                        rm -rf "$LIB/$id"; mkdir -p "$LIB/$id"
                        unzip -q -o "$LIB/$id.epub" -d "$LIB/$id" && echo "$ra" > "$LIB/$id/.ok"
                    fi
                done
                # Remove what was deleted on the server.
                for id in $(printf '%s' "$j" | sed -n '/"archived"/,$p' | grep -o '"[a-z0-9]\{6,\}"' | tr -d '"'); do
                    rm -rf "$LIB/$id" "$LIB/$id.epub"
                done
                ;;
            *) j=$(cat $STATE/library.json 2>/dev/null || echo '{"items":[]}') ;;
        esac
        respond "$j" "application/json" ;;
    /amazon/books)
        # Downloaded Amazon store books (DRM: they open in Amazon's reader).
        # One per line: asin <TAB> title <TAB> author <TAB> percent <TAB> last opened (s)
        out=$(sqlite3 -separator "$(printf '\t')" /var/local/cc.db "select p_cdeKey, p_titles_0_nominal, coalesce(j_credits,''), coalesce(p_percentFinished,0), coalesce(p_lastAccess,0) from Entries where p_cdeType='EBOK' and p_location is not null and p_location like '/mnt/us/%' order by p_lastAccess desc;" 2>/dev/null)
        respond "$out" ;;
    /amazon/cover)
        a=$(q asin)
        case "$a" in ''|*[!A-Za-z0-9]*) respond "error=bad-asin"; exit 0 ;; esac
        F=$(sqlite3 /var/local/cc.db "select p_thumbnail from Entries where p_cdeKey='$a' and p_thumbnail is not null limit 1;" 2>/dev/null)
        [ -f "$F" ] || F=/mnt/us/system/thumbnails/thumbnail_${a}_EBOK_portrait.jpg
        [ -f "$F" ] || { respond "error=no-cover"; exit 0; }
        printf 'HTTP/1.0 200 OK\r\nContent-Type: image/jpeg\r\nCache-Control: max-age=86400\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$(wc -c < "$F" | tr -d ' ')"
        cat "$F" ;;
    /amazon/open)
        # Open in Amazon's reader at the saved page. The path must be percent-encoded.
        a=$(q asin)
        case "$a" in ''|*[!A-Za-z0-9]*) respond "error=bad-asin"; exit 0 ;; esac
        P=$(sqlite3 /var/local/cc.db "select p_location from Entries where p_cdeKey='$a' and p_location is not null limit 1;" 2>/dev/null)
        [ -n "$P" ] || { respond "error=not-downloaded"; exit 0; }
        E=$(printf '%s' "$P" | od -An -tu1 -v | awk '{for(i=1;i<=NF;i++){c=$i+0; if((c>=48&&c<=57)||(c>=65&&c<=90)||(c>=97&&c<=122)||c==47||c==46||c==45||c==95) printf "%c", c; else printf "%%%02X", c}}')
        respond "ok"
        lipc-set-prop com.lab126.appmgrd start "app://com.lab126.booklet.reader$E" ;;
    /book/find|/book/get)
        # Search for a book, or fetch one, through the Nightstand server.
        # The query string passes through as-is (already percent-encoded by the app).
        case "$query" in *[!A-Za-z0-9%._~+=\&-]*) respond '{"message":"bad query"}' "application/json"; exit 0 ;; esac
        . $CFG/server.env 2>/dev/null
        if [ "$path" = /book/find ]; then u="$SERVER_URL/books/find?$query"; t=60; else u="$SERVER_URL/books/get?$query"; t=90; fi
        j=$(curl -s -m $t -H "Authorization: Bearer $SERVER_KEY" "$u")
        case "$j" in \{*) ;; *) j='{"message":"The server did not answer. Check Wi-Fi and try again."}' ;; esac
        respond "$j" "application/json" ;;
    /lib/archive)
        # Remove an item from the Kindle and archive it on the server.
        id=$(q id)
        case "$id" in ''|*[!a-z0-9]*) respond "error=bad-id"; exit 0 ;; esac
        . $CFG/server.env 2>/dev/null
        curl -s -m 15 -X DELETE -H "Authorization: Bearer $SERVER_KEY" "$SERVER_URL/articles/$id" >/dev/null
        rm -rf "$NS/library/$id" "$NS/library/$id.epub" "$STATE/progress/$id"
        respond "ok" ;;
    /lib/file)
        # Serve one file of an unpacked book: /lib/file?p=<id>/OEBPS/text.xhtml
        f=$(q p)
        case "$f" in *..*|/*|'') respond "error=bad-path"; exit 0 ;; esac
        f=$(printf '%s' "$f" | sed 's/%20/ /g')
        F="$NS/library/$f"
        [ -f "$F" ] || { respond "error=missing"; exit 0; }
        case "$F" in
            *.xhtml|*.html|*.htm) t="application/xhtml+xml" ;; *.css) t="text/css" ;; *.opf|*.ncx|*.xml) t="application/xml" ;;
            *.jpg|*.jpeg) t="image/jpeg" ;; *.png) t="image/png" ;; *.gif) t="image/gif" ;; *.svg) t="image/svg+xml" ;; *) t="application/octet-stream" ;;
        esac
        printf 'HTTP/1.0 200 OK\r\nContent-Type: %s\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$t" "$(wc -c < "$F" | tr -d ' ')"
        cat "$F" ;;
    /lib/progress)
        id=$(q id); pr=$(q p); loc=$(q loc)
        case "$id" in ''|*[!a-z0-9]*) respond "error=bad-id"; exit 0 ;; esac
        mkdir -p $STATE/progress
        printf '%s %s %s\n' "$pr" "$loc" "$(date -u +%s)" > $STATE/progress/$id
        respond "ok"
        . $CFG/server.env 2>/dev/null
        curl -s -m 10 -X POST -H "Authorization: Bearer $SERVER_KEY" -H 'content-type: application/json' \
            -d "{\"id\":\"$id\",\"progress\":$pr,\"location\":\"$loc\"}" "$SERVER_URL/progress" >/dev/null 2>&1 & ;;
    /flash)
        respond "ok"
        F=/mnt/us/libkh/bin/fbink; [ -x $F ] || F=/mnt/us/koreader/fbink
        $F -q -f -s top=0,left=0,width=1072,height=1448 ;;
    /stock-home)
        # Escape 1: let the stock home through until the next restart,
        # or until Nightstand is opened again from the library.
        date +%s > /tmp/nightstand-stock
        respond "ok"
        lipc-set-prop com.lab126.appmgrd start "app://com.lab126.KPPMainApp?view=KPP_HOME" ;;
    /sleep)
        # Save the Goodnight screen; the daemon redraws it over the screensaver.
        dd if=/dev/fb0 of=/tmp/nightstand-goodnight.raw bs=1088 count=1448 2>/dev/null
        touch /tmp/nightstand-goodnight
        respond "ok"
        lipc-set-prop com.lab126.powerd powerButton 1 ;;
    *)
        respond "error=unknown" ;;
esac
