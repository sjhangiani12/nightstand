/// <reference types="@cloudflare/workers-types" />
// Nightstand server: tomorrow's schedule (with an AI meeting filter) and the
// weather, for the Kindle. One route: GET /tonight (Bearer SERVER_KEY).
import Anthropic from "@anthropic-ai/sdk";
import ICAL from "ical.js";
import { handleLibrary } from "./library";
import { decide } from "./decide";
import { gcalEvents } from "./gcal";

interface Env {
  DB: D1Database;
  BOOKS: R2Bucket;
  TIMEZONE: string;
  HOME_LAT: string;
  HOME_LON: string;
  SERVER_KEY: string;
  ICS_URLS?: string;
  OWNER_EMAILS?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_SA_KEY?: string;
  GOOGLE_CALENDAR_IDS?: string;
}

type Kind = "meeting" | "block" | "hold" | "skip";

interface Ev {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  others: number; // attendees other than me
  declined: boolean;
  transparent: boolean; // "show as free"
  video: boolean;
  where: string;
  guess: Kind; // rule-based label
}

const MODEL = "claude-opus-5-5";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    const lib = await handleLibrary(req, env, ctx);
    if (lib) return lib;
    if (url.pathname !== "/tonight") return json({ error: "not found" }, 404);
    const auth = req.headers.get("authorization") || "";
    if (!env.SERVER_KEY || auth !== `Bearer ${env.SERVER_KEY}`) return json({ error: "unauthorized" }, 401);

    const tz = env.TIMEZONE || "America/New_York";
    const now = new Date();
    const target = targetDate(now, tz);
    const [cal, weather] = await Promise.all([
      calendar(env, tz, target, ctx).catch((e) => ({ status: "error", error: String(e), events: [] as Ev[], filter: "none" })),
      forecast(env, tz, target).catch(() => null),
    ]);

    const events = cal.events
      .filter((e) => e.guess !== "skip" || e.allDay === false)
      .map((e) => ({
        start: hhmm(e.start, tz),
        end: hhmm(e.end, tz),
        title: e.title,
        kind: e.guess,
        len: duration(e.start, e.end),
        where: e.where,
      }))
      .filter((e) => e.kind !== "skip");
    const first = events.find((e) => e.kind === "meeting") || null;

    return json({
      ok: true,
      generated: now.toISOString(),
      tz,
      tzOffsetMinutes: offsetMinutes(now, tz),
      calendar: cal.status,
      filter: cal.filter,
      tomorrow: { date: target, label: dayLabel(target), events },
      firstMeeting: first ? { start: first.start, title: first.title, where: first.where } : null,
      weather,
    });
  },
};

/* ---------------- calendar ---------------- */

async function calendar(env: Env, tz: string, date: string, ctx: ExecutionContext) {
  const urls = (env.ICS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const gcalIds = (env.GOOGLE_CALENDAR_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!urls.length && !(env.GOOGLE_SA_KEY && gcalIds.length)) return { status: "not-connected", events: [] as Ev[], filter: "none" };
  const me = (env.OWNER_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

  const from = zonedMidnight(date, tz);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);

  // Google Calendar (shared with the Nightstand service account), read-only.
  if (env.GOOGLE_SA_KEY && gcalIds.length) {
    const g = await gcalEvents(env.GOOGLE_SA_KEY, gcalIds, from, to, me);
    const evs: Ev[] = g.map((e) => {
      const ev: Ev = { id: "", title: e.title, start: e.start, end: e.end, allDay: e.allDay, others: e.others, declined: e.declined,
        transparent: e.transparent, video: e.video, where: e.where, guess: "block" };
      ev.guess = e.eventType === "focusTime" ? "block"
        : ["outOfOffice", "workingLocation", "birthday"].includes(e.eventType) ? "skip" : rules(ev);
      ev.id = `e${e.start.getTime().toString(36)}${hash(e.title)}`;
      return ev;
    });
    const seen = new Set<string>();
    const uniq = evs.filter((e) => { const k = `${e.title}|${e.start.getTime()}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return await finishCalendar(env, uniq, tz, ctx);
  }
  const texts = await Promise.all(urls.map((u) => fetch(u, { cf: { cacheTtl: 300 } }).then((r) => (r.ok ? r.text() : ""))));

  const seen = new Set<string>();
  const out: Ev[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const e of expand(text, from, to, me)) {
      const key = `${e.title}|${e.start.getTime()}`; // work + personal can both carry an event
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return await finishCalendar(env, out, tz, ctx);
}

async function finishCalendar(env: Env, out: Ev[], tz: string, ctx: ExecutionContext) {
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  const timed = out.filter((e) => !e.allDay && e.guess !== "skip");

  let filter = "rules";
  if ((env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY) && timed.length) {
    try {
      const labels = await classify(env, timed, tz, ctx);
      for (const e of timed) if (labels[e.id]) e.guess = labels[e.id];
      filter = "ai";
    } catch (err) {
      console.log("filter fell back to rules:", String(err));
    }
  }
  return { status: "ok", events: timed, filter };
}

function expand(text: string, from: Date, to: Date, me: string[]): Ev[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tzc of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tzc);

  const vevents = root.getAllSubcomponents("vevent");
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (v.hasProperty("recurrence-id")) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else masters.set(ex.uid + "#" + String(ex.recurrenceId), ex);
  }

  const res: Ev[] = [];
  for (const ev of masters.values()) {
    const comp = ev.component;
    const status = String(comp.getFirstPropertyValue("status") || "").toUpperCase();
    if (status === "CANCELLED") continue;
    if (ev.isRecurring()) {
      const it = ev.iterator();
      let next: ICAL.Time | null;
      let guard = 0;
      while ((next = it.next()) && guard++ < 5000) {
        const d = ev.getOccurrenceDetails(next);
        const s = d.startDate.toJSDate();
        if (s >= to) break;
        const e = d.endDate.toJSDate();
        if (e <= from) continue;
        res.push(make(d.item, s, e, d.startDate.isDate, me));
      }
    } else {
      const s = ev.startDate.toJSDate();
      const e = (ev.endDate || ev.startDate).toJSDate();
      if (s < to && e > from) res.push(make(ev, s, e, ev.startDate.isDate, me));
    }
  }
  return res;
}

function make(ev: ICAL.Event, start: Date, end: Date, allDay: boolean, me: string[]): Ev {
  const c = ev.component;
  const title = (ev.summary || "Busy").trim();
  let others = 0;
  let declined = false;
  for (const a of c.getAllProperties("attendee")) {
    const mail = String(a.getFirstValue() || "").replace(/^mailto:/i, "").toLowerCase();
    const part = String(a.getParameter("partstat") || "").toUpperCase();
    if (me.includes(mail)) {
      if (part === "DECLINED") declined = true;
    } else if (String(a.getParameter("cutype") || "INDIVIDUAL").toUpperCase() === "INDIVIDUAL") {
      others++;
    }
  }
  const blob = `${ev.location || ""} ${ev.description || ""} ${c.getFirstPropertyValue("x-google-conference") || ""}`;
  const video = /zoom\.us|meet\.google\.com|teams\.microsoft|webex|whereby|around\.co/i.test(blob);
  const where = /zoom\.us/i.test(blob) ? "Zoom" : /meet\.google/i.test(blob) ? "Meet" : /teams\.microsoft/i.test(blob) ? "Teams"
    : (ev.location || "").split(",")[0].trim().slice(0, 32);
  const transparent = String(c.getFirstPropertyValue("transp") || "").toUpperCase() === "TRANSPARENT";
  const e: Ev = { id: "", title, start, end, allDay, others, declined, transparent, video, where, guess: "block" };
  e.guess = rules(e);
  e.id = `e${start.getTime().toString(36)}${hash(title)}`;
  return e;
}

// Rule-based labels: used as hints for the AI, and alone when the AI is off.
function rules(e: Ev): Kind {
  const t = e.title.toLowerCase();
  if (e.allDay || e.declined) return "skip";
  if (/\b(ooo|out of office|flight|travel|commute|birthday)\b/.test(t)) return "skip";
  if (/\b(hold|tentative|maybe|tbd|placeholder|\?)\b/.test(t) || t.includes("?")) return "hold";
  if (/\b(focus|block|deep work|heads? down|no meetings?|lunch|gym|workout|busy|dnd|prep|admin)\b/.test(t)) return "block";
  if (e.others > 0 || e.video) return "meeting";
  return "block";
}

/* ---------------- AI filter ---------------- */

const SYSTEM = `You label calendar events for a person planning their wake-up alarm.
Labels:
- meeting: a real commitment at a fixed time (calls, standups, interviews, 1:1s, appointments, plans to go somewhere or meet someone, events, parties, dinners). Personal plans count even with no attendees listed. These decide the alarm.
- block: time the person blocked for themselves (focus, lunch, gym, prep, commute, reminders, "busy").
- hold: a tentative or placeholder event that may not happen.
- skip: not relevant to the morning plan (declined, cancelled, travel markers, birthdays, all-day notes).
Use the hint fields: other_attendees > 0 and video links usually mean a meeting; a solo event with no link is usually a block. Judge from the title when the hints disagree. Return one label for every id.`;

const SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["meeting", "block", "hold", "skip"] },
        },
        required: ["id", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["labels"],
  additionalProperties: false,
};

async function classify(env: Env, events: Ev[], tz: string, ctx: ExecutionContext): Promise<Record<string, Kind>> {
  const input = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: hhmm(e.start, tz),
    minutes: Math.round((e.end.getTime() - e.start.getTime()) / 60000),
    other_attendees: e.others,
    video_link: e.video,
    shown_as_free: e.transparent,
    rule_guess: e.guess,
  }));
  const body = JSON.stringify(input);

  // Same events -> same labels: cache for 6 h so the Kindle can poll freely.
  const cacheKey = new Request(`https://cache.nightstand/labels/${await sha256(body)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()) as Record<string, Kind>;

  let out: Record<string, Kind> = {};
  if (env.OPENAI_API_KEY) {
    // OpenAI Decisions: one choice question per event, labels only.
    const res = await decide(env.OPENAI_API_KEY, [
      { role: "developer", content: SYSTEM },
      { role: "user", content: body },
    ], events.map((e) => ({
      type: "choice" as const, name: e.id, instructions: `Label the event with id ${e.id}.`,
      choices: [
        { value: "meeting", description: "A real commitment at a fixed time: calls, meetings, interviews, appointments, plans to go somewhere or meet someone, events and parties. Personal plans count even with no attendees listed." },
        { value: "block", description: "Time held for yourself that can move: focus, deep work, lunch, gym, prep, errands, chores, cooking, commute, reminders, \"busy\" holds." },
        { value: "hold", description: "Tentative or placeholder; may not happen." },
        { value: "skip", description: "Not relevant to the morning (declined, travel marker, birthday, all-day note)." },
      ],
    })));
    for (const e of events) { const a = res.answers.get(e.id); if (a?.choice && a.confidence >= 0.5) out[e.id] = a.choice as Kind; }
    console.log(`calendar filter: ${res.inputTokens} tokens`);
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { "cache-control": "max-age=21600" } })));
    return out;
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Label these events:\n${body}` }],
  });
  if (res.stop_reason === "refusal") throw new Error("refused");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = JSON.parse(text) as { labels: { id: string; kind: Kind }[] };
  for (const l of parsed.labels) out[l.id] = l.kind;

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { "cache-control": "max-age=21600" } })));
  return out;
}

/* ---------------- weather ---------------- */

async function forecast(env: Env, tz: string, date: string) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${env.HOME_LAT}&longitude=${env.HOME_LON}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_min,sunrise,weather_code` +
    `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}&forecast_days=3`;
  const r = await fetch(u, { cf: { cacheTtl: 900 } });
  if (!r.ok) return null;
  const w = (await r.json()) as any;
  const i = Math.max(0, (w.daily?.time || []).indexOf(date));
  const now = Math.round(w.current.temperature_2m);
  const low = Math.round(w.daily.temperature_2m_min[i]);
  const sunrise = clock12(String(w.daily.sunrise[i]).slice(11, 16));
  return {
    now: `${now}° and ${words(w.current.weather_code)}`,
    sub: `Low ${low}° · sunrise ${sunrise}`,
    low: `${low}°`,
    sunrise,
    tomorrow: words(w.daily.weather_code[i]),
  };
}

function words(code: number): string {
  if (code === 0) return "clear";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "cloudy";
  if (code <= 48) return "foggy";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  if (code <= 86) return "snow showers";
  return "storms";
}

/* ---------------- time helpers ---------------- */

function parts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour"), min: g("minute") };
}

function offsetMinutes(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return Math.round((asUTC - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

// "Tomorrow" from bedtime's point of view: before 4 AM it is still today.
function targetDate(now: Date, tz: string): string {
  const p = parts(now, tz);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d));
  if (p.h >= 4) base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString().slice(0, 10);
}

function zonedMidnight(date: string, tz: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  return new Date(guess.getTime() - offsetMinutes(guess, tz) * 60000);
}

function hhmm(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
}

function clock12(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}`;
}

function duration(a: Date, b: Date): string {
  const m = Math.round((b.getTime() - a.getTime()) / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h} h ${r} m` : h ? `${h} h` : `${r} min`;
}

function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
