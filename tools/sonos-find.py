#!/usr/bin/env python3
"""Find the Sonos values for private/config/sonos.env.

Usage:
  python3 tools/sonos-find.py SONOS_IP            list rooms and existing alarms
  python3 tools/sonos-find.py SONOS_IP ALARM_ID   copy that alarm's sound into
                                                  private/config/sonos-uri.txt and sonos-meta.txt

Tip: make an alarm in the Sonos app with the sound you want to wake up to
(a playlist, a station), then copy it here. Nightstand never changes that alarm.
"""
import html, os, re, sys, urllib.request

def soap(ip, service, path, action, inner=""):
    body = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            f'<u:{action} xmlns:u="urn:schemas-upnp-org:service:{service}:1">{inner}</u:{action}></s:Body></s:Envelope>')
    req = urllib.request.Request(f"http://{ip}:1400{path}", body.encode(), {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": f'"urn:schemas-upnp-org:service:{service}:1#{action}"'})
    return html.unescape(urllib.request.urlopen(req, timeout=8).read().decode())

def attrs(seg):
    f = {}
    for k, v in re.findall(r'(\w+)="([^"]*)"', seg):
        f.setdefault(k, v)
    return f

ip = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
topo = soap(ip, "ZoneGroupTopology", "/ZoneGroupTopology/Control", "GetZoneGroupState")
print("Rooms (SONOS_ROOM = the UUID):")
for uuid, name in sorted(set(re.findall(r'<ZoneGroupMember UUID="([^"]+)"[^>]*ZoneName="([^"]+)"', topo)), key=lambda x: x[1]):
    print(f"  {name:24} {uuid}")

alarms = soap(ip, "AlarmClock", "/AlarmClock/Control", "ListAlarms")
found = alarms.split("<Alarm ")[1:]
print("\nAlarms:")
for a in found:
    f = attrs(a)
    print(f"  ID {f.get('ID'):4} {f.get('StartTime')}  {f.get('Recurrence'):12} room {f.get('RoomUUID')}")

if len(sys.argv) > 2:
    want = sys.argv[2]
    for a in found:
        f = attrs(a)
        if f.get("ID") == want:
            out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "private", "config")
            os.makedirs(out, exist_ok=True)
            # Keep the XML escaping the helper needs (&lt; &amp;), but plain quotes.
            open(os.path.join(out, "sonos-uri.txt"), "w").write(f.get("ProgramURI", "").replace("&quot;", "\""))
            open(os.path.join(out, "sonos-meta.txt"), "w").write(f.get("ProgramMetaData", "").replace("&quot;", "\""))
            print(f"\nSaved alarm {want}'s sound to private/config/sonos-uri.txt and sonos-meta.txt")
            break
    else:
        sys.exit(f"No alarm with ID {want}")
