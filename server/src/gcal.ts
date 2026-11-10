// Google Calendar, read-only, through a service account that you share
// the calendar with ("See all event details"). No access to the Google
// account itself; revoke by removing the address from the calendar's sharing.
interface SA { client_email: string; private_key: string; token_uri?: string }

let cached: { token: string; exp: number } | null = null;

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(sa: SA): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${header}.${claims}.${b64url(sig)}`,
  });
  const j = (await r.json()) as any;
  if (!j.access_token) throw new Error(`google token: ${j.error || r.status} ${j.error_description || ""}`);
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.token;
}

export interface GEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  others: number;
  declined: boolean;
  transparent: boolean;
  video: boolean;
  where: string;
  eventType: string; // default | focusTime | outOfOffice | workingLocation | birthday | fromGmail
}

export async function gcalEvents(saJson: string, calendarIds: string[], from: Date, to: Date, me: string[]): Promise<GEvent[]> {
  const sa = JSON.parse(saJson) as SA;
  const t = await token(sa);
  const out: GEvent[] = [];
  for (const cal of calendarIds) {
    const q = new URLSearchParams({
      singleEvents: "true", orderBy: "startTime", maxResults: "100",
      timeMin: from.toISOString(), timeMax: to.toISOString(),
    });
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?${q}`, {
      headers: { authorization: `Bearer ${t}` },
    });
    if (!r.ok) throw new Error(`google calendar ${cal}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as any;
    for (const e of j.items || []) {
      if (e.status === "cancelled") continue;
      const allDay = !!e.start?.date;
      const start = new Date(e.start?.dateTime || `${e.start?.date}T00:00:00Z`);
      const end = new Date(e.end?.dateTime || `${e.end?.date}T00:00:00Z`);
      let others = 0, declined = false;
      for (const a of e.attendees || []) {
        const mail = String(a.email || "").toLowerCase();
        if (a.self || me.includes(mail)) { if (a.responseStatus === "declined") declined = true; }
        else if (!a.resource) others++;
      }
      const blob = `${e.location || ""} ${e.description || ""} ${e.hangoutLink || ""}`;
      const video = !!e.conferenceData || !!e.hangoutLink || /zoom\.us|meet\.google|teams\.microsoft/i.test(blob);
      const where = /zoom\.us/i.test(blob) ? "Zoom" : (e.hangoutLink || /meet\.google/i.test(blob)) ? "Meet" : /teams\.microsoft/i.test(blob) ? "Teams"
        : String(e.location || "").split(",")[0].trim().slice(0, 32);
      out.push({
        id: String(e.id), title: String(e.summary || "Busy").trim(), start, end, allDay, others, declined,
        transparent: e.transparency === "transparent", video, where, eventType: e.eventType || "default",
      });
    }
  }
  return out;
}
