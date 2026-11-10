/// <reference types="@cloudflare/workers-types" />
// Articles in, EPUBs out. API + MCP endpoint + the Kindle's sync feed.
//
//   POST /articles            {url} | {html, url?, title?} | {text, title}
//   GET  /articles            recent items
//   GET  /articles/:id        one item + its log
//   POST /articles/:id/retry
//   DELETE /articles/:id
//   GET  /articles/:id/epub   the EPUB file
//   GET  /sync                ready items for the Kindle
//   POST /progress            {id, progress, location}   (from the Kindle)
//   GET  /logs                recent log lines
//   POST /mcp                 MCP (JSON-RPC over HTTP)
//   GET  /add?url=…&key=…     one-tap add (iOS Shortcut, bookmarklet)
//   POST /books               {query} | {source, ref, title?, author?}   find + fetch a book
//   GET  /books               recent books
//   GET  /courier/jobs        (COURIER_KEY) books waiting for Shelfmark
//   POST /courier/jobs/:id/file   (COURIER_KEY) upload the EPUB for a job
//   POST /courier/jobs/:id/fail   (COURIER_KEY) {reason}
import { convert, type Log } from "./articles";
import { buildEpub } from "./epub";
import { findBook, fetchEpub, checkEpub, type Source, type Option } from "./books";

export interface LibEnv {
  DB: D1Database;
  BOOKS: R2Bucket;
  SERVER_KEY: string;
  OPENAI_API_KEY?: string;
  COURIER_KEY?: string;
}

const now = () => Date.now();
const newId = () => Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function logger(env: LibEnv, itemId: string | null): Log {
  return async (level, msg) => {
    console.log(`[${itemId || "-"}] ${level}: ${msg}`);
    await env.DB.prepare("INSERT INTO logs (item_id, at, level, msg) VALUES (?, ?, ?, ?)").bind(itemId, now(), level, msg.slice(0, 2000)).run();
  };
}

/* ---------------- pipeline ---------------- */

export async function addItem(env: LibEnv, input: { url?: string; html?: string; text?: string; title?: string }): Promise<string> {
  const id = newId();
  await env.DB.prepare("INSERT INTO items (id, kind, status, source_url, title, created_at) VALUES (?, 'article', 'queued', ?, ?, ?)")
    .bind(id, input.url || null, input.title || null, now()).run();
  await logger(env, id)("info", `queued: ${input.url || (input.html ? "posted html" : "posted text")}`);
  return id;
}

export async function processItem(env: LibEnv, id: string, input: { url?: string; html?: string; text?: string; title?: string }) {
  const log = logger(env, id);
  const t0 = now();
  await env.DB.prepare("UPDATE items SET status='processing', error=NULL WHERE id=?").bind(id).run();
  try {
    const a = await convert(input, log, { openaiKey: env.OPENAI_API_KEY });
    const epub = buildEpub(a, id);
    const key = `articles/${id}.epub`;
    await env.BOOKS.put(key, epub, { httpMetadata: { contentType: "application/epub+zip" } });
    await env.DB.prepare(`UPDATE items SET status='ready', title=?, author=?, site=?, excerpt=?, words=?, minutes=?, images=?,
      epub_key=?, epub_bytes=?, ready_at=?, cover=? WHERE id=?`)
      .bind(a.title, a.author || null, a.site || null, a.excerpt || null, a.words, a.minutes, a.images.length, key, epub.length, now(), a.cover ? `OEBPS/images/${a.cover.name}` : null, id).run();
    await log("info", `ready: EPUB ${Math.round(epub.length / 1024)} KB in ${now() - t0} ms; the Kindle picks it up on its next sync`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE items SET status='error', error=? WHERE id=?").bind(msg, id).run();
    await log("error", `failed: ${msg}`);
  }
}

/* ---------------- books ---------------- */

const SOURCE_LABEL: Record<string, string> = { standardebooks: "Standard Ebooks", gutenberg: "Project Gutenberg", shelfmark: "Shelfmark" };
const COURIER_FRESH_MS = 10 * 60_000;

async function courierOnline(env: LibEnv): Promise<boolean> {
  if (!env.COURIER_KEY) return false;
  const r: any = await env.DB.prepare("SELECT at FROM kv WHERE k='courier'").first();
  return !!r && now() - r.at < COURIER_FRESH_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ask Shelfmark (through the courier) for releases. The courier long-polls
// /courier/next, so it picks the search up within a second or two.
async function shelfmarkSearch(env: LibEnv, query: string, waitMs = 45_000): Promise<{ options: Option[]; problem?: string }> {
  if (!query.trim()) return { options: [] };
  if (!(await courierOnline(env))) return { options: [], problem: "Shelfmark: not connected" };
  const id = newId();
  await env.DB.prepare("INSERT INTO book_searches (id, query, status, created_at) VALUES (?, ?, 'pending', ?)").bind(id, query.slice(0, 200), now()).run();
  const end = now() + waitMs;
  while (now() < end) {
    await sleep(1200);
    const row: any = await env.DB.prepare("SELECT status, results, error FROM book_searches WHERE id=?").bind(id).first();
    if (row?.status === "error") return { options: [], problem: `Shelfmark: ${row.error || "search failed"}` };
    if (row?.status === "done") {
      const r = JSON.parse(row.results || "{}");
      const book = r.book || {};
      const options: Option[] = (r.releases || []).map((rel: any, i: number) => ({
        source: "shelfmark" as const,
        ref: `${id}:${i}`,
        title: book.title || rel.title || query,
        author: book.author || "",
        note: ["Shelfmark", (rel.format || "").toUpperCase(), rel.size, rel.source_display || rel.source].filter(Boolean).join(" · "),
      }));
      return { options };
    }
  }
  await env.DB.prepare("UPDATE book_searches SET status='error', error='timed out' WHERE id=? AND status IN ('pending','claimed')").bind(id).run();
  return { options: [], problem: `Shelfmark: no answer in ${Math.round(waitMs / 1000)} s` };
}

// Free libraries and Shelfmark together. Free copies come first.
async function findAll(env: LibEnv, query: string) {
  const [free, sm] = await Promise.all([findBook(query), shelfmarkSearch(env, query)]);
  return { ...free, options: [...free.options, ...sm.options], problems: [...free.problems, ...(sm.problem ? [sm.problem] : [])], shelfmark: await courierOnline(env) };
}

async function releaseFor(env: LibEnv, ref: string): Promise<{ release: any; book: any } | null> {
  const m = /^([a-z0-9]+):(\d+)$/.exec(ref);
  if (!m) return null;
  const row: any = await env.DB.prepare("SELECT results FROM book_searches WHERE id=? AND status='done'").bind(m[1]).first();
  if (!row) return null;
  const r = JSON.parse(row.results || "{}");
  const release = (r.releases || [])[Number(m[2])];
  return release ? { release, book: r.book || {} } : null;
}

async function addBook(env: LibEnv, o: { source: Source; ref: string; title?: string; author?: string; isbn?: string; year?: number; release?: any }): Promise<string> {
  const id = newId();
  await env.DB.prepare(`INSERT INTO items (id, kind, status, source, source_ref, title, author, site, want_title, want_author, isbn, year, release, created_at)
    VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, o.source === "shelfmark" ? "waiting" : "queued", o.source, o.ref, o.title || null, o.author || null, SOURCE_LABEL[o.source],
      o.title || null, o.author || null, o.isbn || null, o.year || null, o.release ? JSON.stringify(o.release) : null, now()).run();
  await logger(env, id)("info", `book queued: "${o.title || o.ref}"${o.author ? ` by ${o.author}` : ""} from ${SOURCE_LABEL[o.source]} (${o.ref})`);
  return id;
}

// Check a file and make it ready. Used for free-source downloads and courier uploads.
async function acceptBook(env: LibEnv, id: string, data: Uint8Array, log: Log) {
  const item: any = await env.DB.prepare("SELECT want_title, want_author FROM items WHERE id=?").bind(id).first();
  const c = await checkEpub(data, item?.want_title ? { title: item.want_title, author: item.want_author || "" } : null, log);
  const key = `books/${id}.epub`;
  await env.BOOKS.put(key, c.epub, { httpMetadata: { contentType: "application/epub+zip" } });
  await env.DB.prepare(`UPDATE items SET status='ready', title=?, author=?, words=?, minutes=?, epub_key=?, epub_bytes=?, cover=?, ready_at=?, error=NULL WHERE id=?`)
    .bind(c.title, c.author || null, c.words, Math.max(1, Math.round(c.words / 250)), key, c.epub.length, c.cover, now(), id).run();
  await log("info", `ready: ${Math.round(c.epub.length / 1024)} KB; the Kindle picks it up on its next sync`);
}

async function failItem(env: LibEnv, id: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  await env.DB.prepare("UPDATE items SET status='error', error=? WHERE id=?").bind(msg, id).run();
  await logger(env, id)("error", `failed: ${msg}`);
}

export async function processBook(env: LibEnv, id: string) {
  const log = logger(env, id);
  const item: any = await env.DB.prepare("SELECT source, source_ref FROM items WHERE id=?").bind(id).first();
  if (!item || item.source === "shelfmark") return;
  await env.DB.prepare("UPDATE items SET status='processing', error=NULL WHERE id=?").bind(id).run();
  try {
    const data = await fetchEpub({ source: item.source, ref: item.source_ref }, log);
    await acceptBook(env, id, data, log);
  } catch (e) { await failItem(env, id, e); }
}

// "get me X": pick the best free option, or hand it to Shelfmark, or explain why not.
async function getBook(env: LibEnv, a: { query?: string; source?: string; ref?: string; title?: string; author?: string }): Promise<{ id?: string; message: string; found?: any }> {
  if (a.source && a.ref) {
    if (!["standardebooks", "gutenberg", "shelfmark"].includes(a.source)) return { message: `unknown source ${a.source}` };
    if (a.source === "shelfmark") {
      if (!(await courierOnline(env))) return { message: "Shelfmark is not connected right now (the courier has not checked in for 10 minutes)." };
      const r = await releaseFor(env, a.ref);
      if (!r) return { message: "That Shelfmark result has expired. Search again." };
      const id = await addBook(env, { source: "shelfmark", ref: a.ref, title: a.title || r.book.title, author: a.author || r.book.author, release: r.release });
      return { id, message: "Sent to Shelfmark. The courier downloads it; it reaches the Kindle when it passes the check. Use get_kindle_item to follow it." };
    }
    const id = await addBook(env, { source: a.source as Source, ref: a.ref, title: a.title, author: a.author });
    await processBook(env, id);
    return { id, message: "done" };
  }
  if (!a.query) return { message: "Give a query, or a source and ref from find_book." };
  const found = await findBook(a.query);
  const best: Option | undefined = found.options[0];
  if (best) {
    const id = await addBook(env, { ...best, isbn: found.book?.isbn, year: found.book?.year });
    await processBook(env, id);
    return { id, message: "done", found };
  }
  if (await courierOnline(env)) {
    const b = found.book;
    const sm = await shelfmarkSearch(env, b ? `${b.title} ${b.author}` : a.query);
    const pick = sm.options[0];
    if (pick) {
      const r = await releaseFor(env, pick.ref);
      const id = await addBook(env, { source: "shelfmark", ref: pick.ref, title: b?.title || pick.title, author: b?.author || pick.author, isbn: b?.isbn, year: b?.year, release: r?.release });
      return { id, message: `Not in the free libraries; sent to Shelfmark (${pick.note}). Use get_kindle_item to follow it.`, found };
    }
    return { message: `Not in the free libraries, and Shelfmark found nothing${sm.problem ? ` (${sm.problem})` : ""}.`, found };
  }
  return {
    message: found.book
      ? `"${found.book.title}" by ${found.book.author}${found.book.year ? ` (${found.book.year})` : ""} is not in the free public-domain sources (Standard Ebooks, Project Gutenberg), and Shelfmark is not connected yet.`
      : `No book found for "${a.query}".`,
    found,
  };
}

async function getItem(env: LibEnv, id: string) {
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(id).first();
  if (!item) return null;
  const logs = await env.DB.prepare("SELECT at, level, msg FROM logs WHERE item_id=? ORDER BY id").bind(id).all();
  return { ...item, log: logs.results.map((l: any) => `${new Date(l.at).toISOString().slice(11, 19)} ${l.level}: ${l.msg}`) };
}

async function listItems(env: LibEnv, limit = 30, kind?: string) {
  const r = await env.DB.prepare(`SELECT id, kind, status, title, author, site, minutes, source_url, source, error, created_at, ready_at, delivered_at, progress
    FROM items WHERE archived=0 ${kind ? "AND kind=?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(...(kind ? [kind, limit] : [limit])).all();
  return r.results;
}

/* ---------------- courier (the Shelfmark box) ---------------- */

async function courier(req: Request, env: LibEnv, p: string): Promise<Response> {
  if (!env.COURIER_KEY || req.headers.get("authorization") !== `Bearer ${env.COURIER_KEY}`) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare("INSERT INTO kv (k, v, at) VALUES ('courier', ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, at=excluded.at")
    .bind(req.headers.get("user-agent") || "", now()).run();
  if (p === "/courier/jobs" && req.method === "GET") {
    const r = await env.DB.prepare(`SELECT id, source_ref AS query, want_title AS title, want_author AS author, isbn, year, created_at
      FROM items WHERE kind='book' AND source='shelfmark' AND status='waiting' AND archived=0 ORDER BY created_at LIMIT 5`).all();
    return json({ jobs: r.results });
  }
  // Long poll: answers as soon as a search or a new job is waiting, else after ?wait seconds.
  // Claims what it returns, so the courier sees each search and job once.
  if (p === "/courier/next" && req.method === "GET") {
    const end = now() + Math.min(25, Number(new URL(req.url).searchParams.get("wait") || 20)) * 1000;
    for (;;) {
      const s = await env.DB.prepare("SELECT id, query FROM book_searches WHERE status='pending' AND created_at > ? ORDER BY created_at LIMIT 3").bind(now() - 60_000).all();
      const j = await env.DB.prepare(`SELECT id, source_ref AS query, want_title AS title, want_author AS author, isbn, year, release
        FROM items WHERE kind='book' AND source='shelfmark' AND status='waiting' AND archived=0 ORDER BY created_at LIMIT 3`).all();
      if (s.results.length || j.results.length) {
        for (const x of s.results as any[]) await env.DB.prepare("UPDATE book_searches SET status='claimed' WHERE id=?").bind(x.id).run();
        for (const x of j.results as any[]) {
          await env.DB.prepare("UPDATE items SET status='fetching' WHERE id=?").bind(x.id).run();
          await logger(env, x.id)("info", "courier picked up the job");
        }
        return json({
          searches: s.results,
          jobs: (j.results as any[]).map((x) => ({ ...x, release: x.release ? JSON.parse(x.release) : null })),
        });
      }
      if (now() >= end) return json({ searches: [], jobs: [] });
      await sleep(2000);
    }
  }
  const sr = /^\/courier\/searches\/([a-z0-9]+)$/.exec(p);
  if (sr && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    if (b.error) await env.DB.prepare("UPDATE book_searches SET status='error', error=?, done_at=? WHERE id=?").bind(String(b.error).slice(0, 300), now(), sr[1]).run();
    else await env.DB.prepare("UPDATE book_searches SET status='done', results=?, done_at=? WHERE id=?")
      .bind(JSON.stringify({ book: b.book || null, releases: (b.releases || []).slice(0, 8) }), now(), sr[1]).run();
    return json({ ok: true });
  }
  const pg = /^\/courier\/jobs\/([a-z0-9]+)\/progress$/.exec(p);
  if (pg && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const pct = Math.max(0, Math.min(100, Number(b.pct) || 0));
    await env.DB.prepare("UPDATE items SET fetch_pct=?, fetch_note=? WHERE id=? AND source='shelfmark'").bind(pct, String(b.note || "").slice(0, 120), pg[1]).run();
    return json({ ok: true });
  }
  const m = /^\/courier\/jobs\/([a-z0-9]+)\/(file|fail|log)$/.exec(p);
  if (!m || req.method !== "POST") return json({ error: "not found" }, 404);
  const id = m[1];
  const item: any = await env.DB.prepare("SELECT status FROM items WHERE id=? AND source='shelfmark'").bind(id).first();
  if (!item) return json({ error: "no such job" }, 404);
  const log = logger(env, id);
  if (m[2] === "log") { const b = (await req.json().catch(() => ({}))) as any; await log("info", `courier: ${String(b.msg || "").slice(0, 500)}`); return json({ ok: true }); }
  if (m[2] === "fail") {
    const b = (await req.json().catch(() => ({}))) as any;
    await failItem(env, id, new Error(`Shelfmark: ${String(b.reason || "no reason given").slice(0, 300)}`));
    return json({ ok: true });
  }
  await env.DB.prepare("UPDATE items SET status='processing' WHERE id=?").bind(id).run();
  const data = new Uint8Array(await req.arrayBuffer());
  await log("info", `courier upload: ${req.headers.get("x-filename") || "?"} (${Math.round(data.length / 1024)} KB)`);
  try { await acceptBook(env, id, data, log); return json({ ok: true, status: "ready" }); }
  catch (e) { await failItem(env, id, e); return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 422); }
}

/* ---------------- HTTP ---------------- */

export async function handleLibrary(req: Request, env: LibEnv, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!(p.startsWith("/articles") || p.startsWith("/books") || p.startsWith("/courier/") || p === "/sync" || p === "/progress" || p === "/logs" || p === "/mcp" || p === "/add")) return null;
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });
  }
  if (p.startsWith("/courier/")) return courier(req, env, p); // its own key, never SERVER_KEY
  const auth = req.headers.get("authorization") || "";
  const key = url.searchParams.get("key") || "";
  if (!env.SERVER_KEY || (auth !== `Bearer ${env.SERVER_KEY}` && key !== env.SERVER_KEY)) return json({ error: "unauthorized" }, 401);

  if (p === "/mcp") return mcp(req, env, ctx);

  if (p === "/add") {
    const target = url.searchParams.get("url") || "";
    if (!/^https?:\/\//.test(target)) return json({ error: "send ?url=https://…" }, 400);
    const id = await addItem(env, { url: target });
    ctx.waitUntil(processItem(env, id, { url: target }));
    return new Response(`Sent to Nightstand. It arrives on the Kindle at its next sync.\n\nid: ${id}`, { headers: { "content-type": "text/plain" } });
  }

  if (p === "/articles" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    const input = { url: body.url, html: body.html, text: body.text, title: body.title };
    if (!input.url && !input.html && !input.text) return json({ error: "send {url} or {html} or {text}" }, 400);
    const id = await addItem(env, input);
    if (body.wait) {
      await processItem(env, id, input);
      return json(await getItem(env, id));
    }
    ctx.waitUntil(processItem(env, id, input));
    return json({ id, status: "queued", check: `/articles/${id}` }, 202);
  }
  if (p === "/articles" && req.method === "GET") return json(await listItems(env, Number(url.searchParams.get("limit") || 30)));
  if (p === "/books" && req.method === "GET") return json(await listItems(env, Number(url.searchParams.get("limit") || 30), "book"));
  if (p === "/books" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const r = await getBook(env, b);
    return json({ ...r, item: r.id ? await getItem(env, r.id) : null }, r.id ? 200 : 404);
  }
  if (p === "/books/find") {
    return json(await findAll(env, url.searchParams.get("q") || ""));
  }
  // GET form of POST /books, for the Kindle helper (plain query string, no JSON in shell).
  if (p === "/books/get") {
    const sp = url.searchParams;
    const r = await getBook(env, { query: sp.get("query") || undefined, source: sp.get("source") || undefined, ref: sp.get("ref") || undefined, title: sp.get("title") || undefined, author: sp.get("author") || undefined });
    const item: any = r.id ? await getItem(env, r.id) : null;
    return json({ message: r.message, id: r.id || null, status: item?.status || null, error: item?.error || null, title: item?.title || null });
  }
  if (p === "/logs") {
    const r = await env.DB.prepare("SELECT item_id, at, level, msg FROM logs ORDER BY id DESC LIMIT ?").bind(Number(url.searchParams.get("limit") || 100)).all();
    return json(r.results);
  }

  const m = /^\/articles\/([a-z0-9]+)(\/(epub|retry))?$/.exec(p);
  if (m) {
    const id = m[1];
    if (m[3] === "epub") {
      const item: any = await env.DB.prepare("SELECT epub_key FROM items WHERE id=?").bind(id).first();
      const obj = item?.epub_key ? await env.BOOKS.get(item.epub_key) : null;
      if (!obj) return json({ error: "no epub" }, 404);
      return new Response(obj.body, { headers: { "content-type": "application/epub+zip", "content-length": String(obj.size) } });
    }
    if (m[3] === "retry" && req.method === "POST") {
      const item: any = await env.DB.prepare("SELECT source_url FROM items WHERE id=?").bind(id).first();
      if (!item?.source_url) return json({ error: "nothing to retry (posted html/text is not kept)" }, 400);
      ctx.waitUntil(processItem(env, id, { url: item.source_url }));
      return json({ id, status: "queued" }, 202);
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("UPDATE items SET archived=1 WHERE id=?").bind(id).run();
      return json({ id, archived: true });
    }
    const item = await getItem(env, id);
    return item ? json(item) : json({ error: "not found" }, 404);
  }

  if (p === "/sync") {
    // Everything ready, newest first. The Kindle downloads what it lacks.
    const r = await env.DB.prepare(`SELECT id, kind, title, author, site, minutes, words, epub_bytes, ready_at, progress, location, cover
      FROM items WHERE status='ready' AND archived=0 ORDER BY ready_at DESC LIMIT 200`).all();
    const ids = r.results.filter((x: any) => x).map((x: any) => x.id);
    if (ids.length) ctx.waitUntil(env.DB.prepare(`UPDATE items SET delivered_at=? WHERE delivered_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(now(), ...ids).run());
    const pending = await env.DB.prepare(`SELECT id, title, author, status, fetch_pct, fetch_note, error, created_at FROM items
      WHERE kind='book' AND archived=0 AND (status IN ('waiting','fetching','processing','queued') OR (status='error' AND created_at > ?))
      ORDER BY created_at DESC LIMIT 20`).bind(now() - 86_400_000).all();
    return json({ items: r.results, pending: pending.results, archived: (await env.DB.prepare("SELECT id FROM items WHERE archived=1").all()).results.map((x: any) => x.id) });
  }

  if (p === "/progress" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    if (!b.id) return json({ error: "id" }, 400);
    await env.DB.prepare("UPDATE items SET progress=?, location=?, progress_at=? WHERE id=?").bind(Number(b.progress) || 0, String(b.location || ""), now(), b.id).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/* ---------------- MCP (JSON-RPC 2.0 over HTTP, stateless) ---------------- */

const TOOLS = [
  {
    name: "send_to_kindle",
    description: "Send a web article to the user's Kindle (Nightstand). The server fetches the page, extracts the article, converts it to an EPUB and the Kindle downloads it on its next sync. Returns the item with its processing log.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The article URL." },
        html: { type: "string", description: "Optional: the page HTML, for pages behind a login or paywall." },
        text: { type: "string", description: "Optional: plain text to send instead of a URL." },
        title: { type: "string", description: "Optional title override." },
      },
    },
  },
  {
    name: "list_kindle_items",
    description: "List recent items sent to the Kindle with their status (queued, processing, ready, error) and reading progress.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "get_kindle_item",
    description: "Get one item with its full processing log.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "retry_kindle_item",
    description: "Run the conversion again for an item that failed.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "find_book",
    description: "Look up a book the user wants to read, WITHOUT downloading. Returns what Open Library says the book is (title, author, year, ISBN) and the copies available: free libraries first (Project Gutenberg, Standard Ebooks), then Shelfmark releases (format, size, source in the note). Takes up to ~45 s while Shelfmark searches. Show the options and let the user pick; then call get_book with that option's source and ref.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Title, and author if known, e.g. 'Frankenstein Mary Shelley'." } }, required: ["query"] },
  },
  {
    name: "get_book",
    description: "Get a book onto the user's Kindle. Either pass a query (picks the best match automatically) or a source + ref from find_book (exact copy). The file is checked before delivery: real EPUB, no DRM, right title and author, full book (not a summary or sample). Returns the item with its log. The Kindle downloads it on its next sync and opens it in Nightstand's own reader.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Title and author, e.g. 'Pride and Prejudice Jane Austen'." },
        source: { type: "string", enum: ["standardebooks", "gutenberg", "shelfmark"], description: "From a find_book option." },
        ref: { type: "string", description: "From a find_book option." },
        title: { type: "string", description: "With source+ref: the title the user wants (the file is checked against it)." },
        author: { type: "string", description: "With source+ref: the author." },
      },
    },
  },
  {
    name: "list_books",
    description: "List books sent to the Kindle, newest first, with status and reading progress.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "remove_book",
    description: "Remove a book (or article) from the Kindle. It disappears on the Kindle's next sync.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

async function mcp(req: Request, env: LibEnv, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "GET") return new Response("Nightstand MCP: POST JSON-RPC here.", { status: 405 });
  const msg = (await req.json().catch(() => null)) as any;
  if (!msg) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  const batch = Array.isArray(msg) ? msg : [msg];
  const out: any[] = [];
  for (const m of batch) {
    const r = await mcpOne(m, env, ctx);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(msg) ? out : out[0]);
}

async function mcpOne(m: any, env: LibEnv, ctx: ExecutionContext): Promise<any> {
  const ok = (result: any) => ({ jsonrpc: "2.0", id: m.id, result });
  const text = (v: any) => ok({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  switch (m.method) {
    case "initialize":
      return ok({
        protocolVersion: m.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "nightstand", version: "0.1.0" },
        instructions: "the user's Kindle (Nightstand). Articles: send_to_kindle with a URL. Books: get_book with a title and author; use find_book first if the request is ambiguous. Only DRM-free books; Nightstand never strips DRM.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = m.params?.name;
      const a = m.params?.arguments || {};
      if (name === "send_to_kindle") {
        if (!a.url && !a.html && !a.text) return text("Give a url, html or text.");
        const input = { url: a.url, html: a.html, text: a.text, title: a.title };
        const id = await addItem(env, input);
        await processItem(env, id, input);
        return text(await getItem(env, id));
      }
      if (name === "list_kindle_items") return text(await listItems(env, Number(a.limit) || 20));
      if (name === "find_book") {
        return text(await findAll(env, String(a.query || "")));
      }
      if (name === "get_book") {
        const r = await getBook(env, a);
        return text({ message: r.message, item: r.id ? await getItem(env, r.id) : null, ...(r.id ? {} : { found: r.found }) });
      }
      if (name === "list_books") return text(await listItems(env, Number(a.limit) || 20, "book"));
      if (name === "remove_book") {
        await env.DB.prepare("UPDATE items SET archived=1 WHERE id=?").bind(String(a.id)).run();
        return text({ id: a.id, removed: true });
      }
      if (name === "get_kindle_item") return text((await getItem(env, String(a.id))) || "not found");
      if (name === "retry_kindle_item") {
        const item: any = await env.DB.prepare("SELECT source_url FROM items WHERE id=?").bind(String(a.id)).first();
        if (!item?.source_url) return text("Nothing to retry.");
        await processItem(env, String(a.id), { url: item.source_url });
        return text(await getItem(env, String(a.id)));
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${name}` } };
    }
    default:
      if (m.id === undefined) return null;
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
  }
}
