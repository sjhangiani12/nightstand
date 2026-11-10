// Books in, EPUBs out. Find a book, fetch a DRM-free EPUB, check it, store it.
// The Kindle picks it up through /sync like an article (kind = 'book').
//
// Sources, in order of preference:
//   standardebooks  Standard Ebooks (public domain, carefully typeset)
//   gutenberg       Project Gutenberg, via the Gutendex API
//   shelfmark       a separate box (the "courier") that runs Shelfmark. It polls
//                   /courier/jobs and uploads the file. Not connected yet.
//
// Every file passes checkEpub() before it reaches the Kindle: a real EPUB,
// no DRM (we never strip it), the right title and author, not a summary or a
// sample. Cover pages drawn in SVG are marked linear="no" so the Kindle's old
// web engine skips them.
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from "fflate";
import type { Log } from "./articles";

export type Source = "standardebooks" | "gutenberg" | "shelfmark";

export interface Identity { title: string; author: string; year?: number; isbn?: string }
export interface Option { source: Source; ref: string; title: string; author: string; note: string }

const UA = "Nightstand/1.0 (personal e-reader)";
const MAX_BYTES = 60_000_000;
const MIN_WORDS = 5_000; // anything shorter is a sample, an excerpt or a pamphlet

/* ---------------- identify ---------------- */

// Open Library: which book is meant? Canonical title, author, first year, an ISBN.
export async function identify(query: string): Promise<Identity[]> {
  const u = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=title,author_name,first_publish_year,isbn,edition_count&limit=5`;
  const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const d = (await r.json()) as any;
  return (d.docs || [])
    .filter((x: any) => x.title && x.author_name?.length)
    .map((x: any) => ({
      title: String(x.title),
      author: String(x.author_name[0]),
      year: x.first_publish_year || undefined,
      isbn: (x.isbn || []).find((i: string) => /^97[89]\d{10}$/.test(i)),
    }));
}

/* ---------------- free sources ---------------- */

async function searchStandardEbooks(query: string): Promise<Option[]> {
  const r = await fetch(`https://standardebooks.org/ebooks?query=${encodeURIComponent(query)}&per-page=12`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes("ebooks-list")) throw new Error(`unexpected page (${html.length} chars): ${html.slice(0, 80).replace(/\s+/g, " ")}`);
  const out: Option[] = [];
  for (const m of html.matchAll(/<li typeof="schema:Book" about="\/ebooks\/([a-z0-9_\/-]+)">([\s\S]*?)<\/li>/g)) {
    const names = [...m[2].matchAll(/property="schema:name">([^<]+)</g)].map((x) => decode(x[1]));
    if (names.length < 2) continue;
    out.push({ source: "standardebooks", ref: m[1], title: names[0], author: names[1], note: "Standard Ebooks: public domain, carefully typeset" });
  }
  return out;
}

// Gutenberg's own OPDS search: fast and official. Gutendex is the fallback.
async function searchGutenberg(query: string): Promise<Option[]> {
  try {
    const r = await fetch(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(query)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const x = await r.text();
    const out: Option[] = [];
    for (const m of x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const id = /<id>https?:\/\/www\.gutenberg\.org\/ebooks\/(\d+)\.opds<\/id>/.exec(m[1])?.[1];
      const title = /<title>([^<]*)<\/title>/.exec(m[1])?.[1];
      if (!id || !title) continue;
      const author = /<content[^>]*>([^<]*)<\/content>/.exec(m[1])?.[1] || "";
      out.push({ source: "gutenberg", ref: id, title: decode(title), author: decode(author), note: `Project Gutenberg #${id}` });
      if (out.length >= 6) break;
    }
    return out;
  } catch (e) {
    const fallback = await searchGutendex(query).catch(() => [] as Option[]);
    if (fallback.length) return fallback;
    throw e;
  }
}

async function searchGutendex(query: string): Promise<Option[]> {
  const r = await fetch(`https://gutendex.com/books/?search=${encodeURIComponent(query)}&languages=en`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()) as any;
  return (d.results || [])
    .filter((x: any) => x.formats?.["application/epub+zip"] && !x.copyright)
    .slice(0, 6)
    .map((x: any) => ({
      source: "gutenberg" as const,
      ref: String(x.id),
      title: String(x.title).replace(/\s*;\s*/, ": "),
      author: flipName(x.authors?.[0]?.name || ""),
      note: `Project Gutenberg #${x.id} (${x.download_count} downloads)`,
    }));
}

function downloadUrl(o: { source: Source; ref: string }): string {
  if (o.source === "standardebooks") {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+(\/[a-z0-9_-]+)?$/.test(o.ref)) throw new Error(`bad Standard Ebooks ref: ${o.ref}`);
    return `https://standardebooks.org/ebooks/${o.ref}/downloads/${o.ref.replace(/\//g, "_")}.epub?source=download`;
  }
  if (o.source === "gutenberg") {
    if (!/^\d+$/.test(o.ref)) throw new Error(`bad Gutenberg ref: ${o.ref}`);
    return `https://www.gutenberg.org/ebooks/${o.ref}.epub3.images`;
  }
  throw new Error("Shelfmark books come from the courier, not a URL");
}

/* ---------------- find ---------------- */

export interface Found { book: Identity | null; options: Option[]; others: Identity[]; problems: string[] }

// One search across the free sources, ranked against what Open Library says
// the book is. Claude shows this to the user when the match is unclear.
export async function findBook(query: string): Promise<Found> {
  const problems: string[] = [];
  const soft = <T,>(name: string, p: Promise<T[]>) => p.catch((e) => { problems.push(`${name}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`); return [] as T[]; });
  const [ids, se, pg] = await Promise.all([
    soft("Open Library", identify(query)),
    soft("Standard Ebooks", searchStandardEbooks(query)),
    soft("Project Gutenberg", searchGutenberg(query)),
  ]);
  const book = ids[0] || null;
  const target = book || { title: query, author: "" };
  const scored = [...se, ...pg]
    .map((o) => ({ o, s: matchScore(o, target) + (o.source === "standardebooks" ? 0.05 : 0) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.o);
  return { book, options: scored, others: ids.slice(1, 4), problems };
}

/* ---------------- fetch + check ---------------- */

export interface Checked {
  epub: Uint8Array;
  title: string;
  author: string;
  cover: string | null; // path inside the EPUB
  words: number;
  chapters: number;
  notes: string[];
}

export async function fetchEpub(o: { source: Source; ref: string }, log: Log): Promise<Uint8Array> {
  const url = downloadUrl(o);
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/epub+zip" }, redirect: "follow", signal: AbortSignal.timeout(45000) });
  await log("info", `download ${url} -> HTTP ${r.status}, ${r.headers.get("content-type") || "?"}, ${r.headers.get("content-length") || "?"} bytes`);
  if (!r.ok) throw new Error(`the source returned HTTP ${r.status}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error(`file too big (${Math.round(len / 1e6)} MB)`);
  const data = new Uint8Array(await r.arrayBuffer());
  if (data.length > MAX_BYTES) throw new Error(`file too big (${Math.round(data.length / 1e6)} MB)`);
  return data;
}

// The gate. Throws with a plain reason when the file must not reach the Kindle.
export async function checkEpub(data: Uint8Array, expect: { title?: string; author?: string } | null, log: Log): Promise<Checked> {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("not an EPUB (not a zip file)");
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(data); } catch (e) { throw new Error(`the EPUB is damaged (${String(e).slice(0, 80)})`); }
  const notes: string[] = [];

  const mt = files["mimetype"] ? strFromU8(files["mimetype"]).trim() : "";
  if (mt !== "application/epub+zip") throw new Error(`not an EPUB (mimetype "${mt || "missing"}")`);

  // DRM. Font obfuscation (IDPF / Adobe) is harmless and allowed; anything else is encryption.
  if (files["META-INF/rights.xml"]) throw new Error("the book has DRM (Adobe rights.xml). Nightstand never strips DRM");
  const enc = files["META-INF/encryption.xml"] ? strFromU8(files["META-INF/encryption.xml"]) : "";
  if (enc) {
    const algos = [...enc.matchAll(/Algorithm="([^"]+)"/g)].map((m) => m[1]);
    const bad = algos.filter((a) => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a));
    if (bad.length) throw new Error(`the book has DRM (${bad[0]}). Nightstand never strips DRM`);
    notes.push(`fonts obfuscated (${algos.length}), not DRM`);
  }

  const container = files["META-INF/container.xml"] ? strFromU8(files["META-INF/container.xml"]) : "";
  const rf = /<rootfile\s[^>]*full-path="([^"]+)"/.exec(container);
  if (!rf || !files[rf[1]]) throw new Error("the EPUB has no package file");
  const opfPath = rf[1];
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  let opf = strFromU8(files[opfPath]);

  const titles = [...opf.matchAll(/<dc:title[^>]*>([^<]*)</g)].map((m) => decode(m[1]).trim()).filter(Boolean);
  const title = titles[0] || "Untitled";
  const author = [...opf.matchAll(/<dc:creator[^>]*>([^<]*)</g)].map((m) => decode(m[1]).trim()).filter(Boolean).join(", ");

  // Manifest and spine.
  const items: Record<string, { href: string; type: string; props: string }> = {};
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const id = attr(m[0], "id");
    if (id) items[id] = { href: attr(m[0], "href"), type: attr(m[0], "media-type"), props: attr(m[0], "properties") };
  }
  const spine = [...opf.matchAll(/<itemref\s[^>]*>/g)].map((m) => ({ tag: m[0], idref: attr(m[0], "idref") }));
  if (!spine.length) throw new Error("the EPUB has no readable pages");

  // Skip SVG-only cover pages (the Kindle's web engine draws them badly).
  let changed = false;
  for (const it of spine) {
    const item = items[it.idref];
    if (!item || /linear="no"/.test(it.tag)) continue;
    const body = files[join(base, item.href)];
    const svgPage = /\bsvg\b/.test(item.props) || (body && isSvgCover(strFromU8(body)));
    if (svgPage && spine.indexOf(it) < 3) {
      opf = opf.replace(it.tag, it.tag.replace(/\s*\/?>$/, (end) => ` linear="no"${end}`));
      changed = true;
      notes.push(`skipped SVG cover page ${item.href}`);
    }
  }

  // Cover image.
  let cover: string | null = null;
  const coverItem = Object.values(items).find((i) => /\bcover-image\b/.test(i.props));
  const metaCover = /<meta\s[^>]*name="cover"[^>]*content="([^"]+)"/.exec(opf) || /<meta\s[^>]*content="([^"]+)"[^>]*name="cover"/.exec(opf);
  const ci = coverItem || (metaCover ? items[metaCover[1]] : undefined);
  if (ci && /^image\/(jpeg|png|gif)$/.test(ci.type) && files[join(base, ci.href)]) cover = join(base, ci.href);
  if (ci && !cover) notes.push(`cover skipped (${ci.type})`);

  // Formats the Kindle cannot show.
  const webp = Object.values(items).filter((i) => /webp|avif/.test(i.type)).length;
  if (webp) notes.push(`${webp} WebP/AVIF images will not show on the Kindle`);

  // Size of the actual text.
  let words = 0;
  for (const it of spine) {
    const item = items[it.idref];
    const f = item && files[join(base, item.href)];
    if (!f) continue;
    const text = strFromU8(f).replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
    words += text.split(/\s+/).filter((w) => /\w/.test(w)).length;
  }

  // Is this the book that was asked for, and is it the book itself?
  if (/\b(summary of|study guide|workbook for|analysis of|sparknotes|cliffsnotes|book summary|excerpt|sample)\b/i.test(titles.join(" ")))
    throw new Error(`this is not the book itself ("${title}")`);
  if (words < MIN_WORDS) throw new Error(`only ${words} words: a sample or an excerpt, not the full book`);
  if (expect?.title) {
    const s = matchScore({ title: titles.join(" "), author }, { title: expect.title, author: expect.author || "" });
    await log("info", `match: file "${title}" by ${author || "?"} vs wanted "${expect.title}"${expect.author ? ` by ${expect.author}` : ""} -> ${s.toFixed(2)}`);
    if (s < 0.5) throw new Error(`wrong book: the file is "${title}" by ${author || "unknown"}`);
  }

  let epub = data;
  if (changed) {
    files[opfPath] = strToU8(opf);
    const z: Zippable = { mimetype: [files["mimetype"], { level: 0 }] };
    for (const [k, v] of Object.entries(files)) if (k !== "mimetype") z[k] = [v, { level: /\.(jpe?g|png|gif|woff2?)$/i.test(k) ? 0 : 6 }];
    epub = zipSync(z);
  }
  await log("info", `check ok: "${title}" by ${author || "?"}, ${words} words, ${spine.length} parts, cover ${cover ? "yes" : "no"}${notes.length ? "; " + notes.join("; ") : ""}`);
  return { epub, title, author, cover, words, chapters: spine.length, notes };
}

/* ---------------- matching ---------------- */

const STOP = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "by", "with", "novel", "book", "edition", "complete"]);
function words(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
}
// 0..1. The main title (before ":" / ";" / "(") must be covered; the author's
// last name, when we know it, must appear.
export function matchScore(have: { title: string; author: string }, want: { title: string; author: string }): number {
  const main = words(want.title.split(/[:;(]/)[0]);
  const got = new Set(words(have.title));
  if (!main.length) return 0;
  const cover = main.filter((w) => got.has(w)).length / main.length;
  let s = cover;
  const last = words(want.author).pop();
  if (last) s = words(have.author).includes(last) ? s : s * 0.4;
  return s;
}

/* ---------------- helpers ---------------- */

function isSvgCover(xhtml: string): boolean {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(xhtml)?.[1] || "";
  return /<svg[\s>]/i.test(body) && body.replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/<[^>]+>/g, "").trim().length < 40;
}
function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : "";
}
function join(base: string, href: string): string {
  const parts = (base + decodeURIComponent(href.split("#")[0])).split("/");
  const out: string[] = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); }
  return out.join("/");
}
function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function flipName(n: string): string {
  const m = /^([^,]+),\s*(.+)$/.exec(n);
  return m ? `${m[2]} ${m[1]}` : n;
}
