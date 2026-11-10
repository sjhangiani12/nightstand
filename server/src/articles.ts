// The conversion step: a web page (or posted HTML / text) -> clean, e-ink
// friendly XHTML + images, ready to be packed into an EPUB.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { decide, cost, type ChoiceQuestion } from "./decide";

export interface Img { name: string; type: string; data: Uint8Array }
export interface Heading { id: string; level: number; text: string }
export interface Article {
  title: string;
  author: string;
  site: string;
  excerpt: string;
  published: string;
  url: string;
  xhtml: string;       // body content, well-formed XHTML
  headings: Heading[]; // for the table of contents
  images: Img[];
  cover: Img | null;  // the page's share image, as the book cover
  words: number;
  minutes: number;
}

export type Log = (level: "info" | "warn" | "error", msg: string) => Promise<void>;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAX_IMAGES = 25;
const MAX_IMAGE_BYTES = 2_500_000;

export async function fetchPage(url: string, log: Log): Promise<string> {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
  });
  await log("info", `fetched ${url} -> HTTP ${r.status}, ${r.headers.get("content-type") || "?"}`);
  if (!r.ok) throw new Error(`the page returned HTTP ${r.status}`);
  const type = r.headers.get("content-type") || "";
  if (!/html|xml/i.test(type)) throw new Error(`not a web page (${type})`);
  return await r.text();
}

export async function convert(input: { url?: string; html?: string; text?: string; title?: string }, log: Log, opts: { openaiKey?: string } = {}): Promise<Article> {
  const url = input.url || "";
  let html = input.html || "";
  if (!html && input.text) {
    html = `<html><head><title>${esc(input.title || "Untitled")}</title></head><body><article>${input.text
      .split(/\n{2,}/).map((p) => `<p>${esc(p.trim())}</p>`).join("")}</article></body></html>`;
    await log("info", `converting posted text (${input.text.length} chars)`);
  }
  if (!html && url) html = await substack(url, log);
  if (!html) {
    if (!url) throw new Error("send a url, html or text");
    html = await fetchPage(url, log);
  } else if (input.html) {
    await log("info", `converting posted html (${html.length} chars)`);
  }

  const { document } = parseHTML(html);
  // Readability needs absolute links to resolve relative ones.
  if (url && !document.querySelector("base")) {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  }
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  const pageTitle = (document.querySelector("title")?.textContent || "").trim();
  const firstH1 = (document.querySelector("h1")?.textContent || "").replace(/\s+/g, " ").trim();
  const ogTitle = meta('meta[property="og:title"]');
  const ogImage = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  const parsed = new Readability(document as any, { charThreshold: 300, keepClasses: false }).parse();

  let title = (input.title || parsed?.title || ogTitle || pageTitle || "Untitled").trim();
  const author = (parsed?.byline || meta('meta[name="author"]') || "").replace(/^by\s+/i, "").trim();
  const site = (parsed?.siteName || meta('meta[property="og:site_name"]') || hostOf(url)).trim();
  const published = (parsed?.publishedTime || meta('meta[property="article:published_time"]') || "").slice(0, 10);
  if (parsed?.content) await log("info", `readability: "${title}" by ${author || "?"} (${site || "?"}), ${parsed.length} chars`);
  else await log("warn", "readability found no article");

  let { document: doc } = parseHTML(`<html><body><div id="root">${parsed?.content || ""}</div></body></html>`);
  let root: any = doc.getElementById("root")!;
  let mode: "clean" | "rescue" = "clean";

  // Rescue: Readability found too little. Let the AI pick the article out of the whole page.
  if (countWords(root) < 120 && opts.openaiKey) {
    const full = parseHTML(html).document;
    for (const el of Array.from(full.querySelectorAll("script,style,noscript,svg,iframe,form,template")) as any[]) el.remove();
    root = full.body;
    mode = "rescue";
    await log("warn", `readability kept only ${countWords(doc.getElementById("root"))} words; AI rescue over the whole page`);
  }

  // AI clean-up: label every block, drop only the confident "not the article" ones.
  if (opts.openaiKey) {
    try {
      const candidates = Array.from(new Set([input.title, parsed?.title, ogTitle, firstH1, pageTitle].map((t) => (t || "").replace(/\s+/g, " ").trim()).filter((t) => t && t.length < 250)));
      const r = await aiClean(root, { title, site, url, candidates, mode }, opts.openaiKey, log);
      if (r.title && !input.title) title = r.title;
    } catch (e) {
      await log("warn", `AI clean-up skipped (${String(e).slice(0, 200)}); using the rules-only result`);
    }
  }
  if (!parsed?.content && countWords(root) < 120) throw new Error("could not find an article on the page");

  // Images: pick the best source, fetch as JPEG/PNG/GIF (the Kindle's
  // browser engine cannot show WebP or AVIF), and keep them in the book.
  const images: Img[] = [];
  const imgs = Array.from(root.querySelectorAll("img")) as any[];
  for (const img of imgs) {
    const src = bestSrc(img, url);
    if (!src || images.length >= MAX_IMAGES) { img.remove(); continue; }
    try {
      const got = await fetchImage(src);
      if (!got) { await log("warn", `image skipped (unsupported format): ${src.slice(0, 120)}`); img.remove(); continue; }
      const name = `img${String(images.length + 1).padStart(3, "0")}.${got.ext}`;
      images.push({ name, type: got.type, data: got.data });
      img.setAttribute("data-ns-src", `images/${name}`);
    } catch (e) {
      await log("warn", `image skipped (${String(e)}): ${src.slice(0, 120)}`);
      img.remove();
    }
  }
  if (imgs.length) await log("info", `images: kept ${images.length} of ${imgs.length}`);

  // Cover: the share image, or the first image in the article.
  let cover: Img | null = null;
  const coverSrc = ogImage ? kindleSized(new URL(ogImage, url || undefined).toString()) : "";
  if (coverSrc) {
    try {
      const got = await fetchImage(coverSrc);
      if (got) cover = { name: `cover.${got.ext}`, type: got.type, data: got.data };
    } catch (e) { await log("warn", `cover skipped (${String(e)})`); }
  }
  if (cover && !coverWorthy(cover.data)) { await log("info", "share image too small for a cover; skipped"); cover = null; }
  if (!cover) { const big = images.find((im) => coverWorthy(im.data)); if (big) cover = { ...big, name: `cover.${big.name.split(".").pop()}` }; }
  if (cover) await log("info", `cover: ${ogImage ? "share image" : "first article image"} (${Math.round(cover.data.length / 1024)} KB)`);

  const headings: Heading[] = [];
  const xhtml = serialize(root, url, headings);
  const text = (root.textContent || "").replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  if (words < 120) throw new Error(`only ${words} words found: the page may be behind a paywall or a login. Try sending the page's HTML instead.`);
  const minutes = Math.max(1, Math.round(words / 230));
  await log("info", `clean text: ${words} words, about ${minutes} min, ${headings.length} headings`);

  return { title, author, site, excerpt: (parsed?.excerpt || "").trim().slice(0, 300), published, url, xhtml, headings, images, cover, words, minutes };
}

/* ---------------- cover check ---------------- */

// Width and height from the image header (JPEG, PNG, GIF).
export function imageSize(d: Uint8Array): { w: number; h: number } | null {
  if (d[0] === 0x89 && d[1] === 0x50) return { w: (d[16] << 24 | d[17] << 16 | d[18] << 8 | d[19]) >>> 0, h: (d[20] << 24 | d[21] << 16 | d[22] << 8 | d[23]) >>> 0 };
  if (d[0] === 0x47 && d[1] === 0x49) return { w: d[6] | d[7] << 8, h: d[8] | d[9] << 8 };
  if (d[0] === 0xff && d[1] === 0xd8) {
    let i = 2;
    while (i + 9 < d.length) {
      if (d[i] !== 0xff) { i++; continue; }
      const m = d[i + 1], len = d[i + 2] << 8 | d[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: d[i + 7] << 8 | d[i + 8], h: d[i + 5] << 8 | d[i + 6] };
      i += 2 + len;
    }
  }
  return null;
}
// A cover must be big enough to fill a book-shaped card without blurring.
function coverWorthy(d: Uint8Array): boolean {
  const s = imageSize(d);
  return !!s && s.w >= 400 && s.h >= 200 && s.w / s.h <= 3;
}

/* ---------------- site handlers ---------------- */

// Substack (and its custom domains) blocks server fetches of the page, but
// serves each post as JSON at /api/v1/posts/<slug>. Use that when it exists.
async function substack(url: string, log: Log): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { return ""; }
  const m = /^\/p\/([^/?#]+)/.exec(u.pathname);
  if (!m) return "";
  try {
    const r = await fetch(`${u.origin}/api/v1/posts/${m[1]}`, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return "";
    const d = (await r.json()) as any;
    if (!d?.body_html) return "";
    const author = (d.publishedBylines || []).map((b: any) => b.name).filter(Boolean).join(", ");
    await log("info", `substack post via JSON: "${d.title}" by ${author || "?"}${d.audience && d.audience !== "everyone" ? ` (audience: ${d.audience}, may be cut short)` : ""}`);
    return `<html><head><title>${esc(d.title || "")}</title><meta name="author" content="${esc(author)}"/>` +
      `<meta property="og:site_name" content="${esc(u.hostname.replace(/^www\./, ""))}"/>` +
      `<meta property="article:published_time" content="${esc(d.post_date || "")}"/></head>` +
      `<body><article><h1>${esc(d.title || "")}</h1>${d.subtitle ? `<p><em>${esc(d.subtitle)}</em></p>` : ""}${d.body_html}</article></body></html>`;
  } catch {
    return "";
  }
}

/* ---------------- images ---------------- */

function bestSrc(img: any, base: string): string {
  const cands: string[] = [];
  const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
  if (srcset) {
    // largest width that is not wider than ~1600 px
    // Entries are separated by a comma AND whitespace: CDN URLs often contain commas.
    const parts = srcset.split(/,\s+/).map((s: string) => s.trim().split(/\s+/)).map(([u, w]: string[]) => ({ u, w: parseInt(w) || 0 }));
    parts.sort((a: any, b: any) => b.w - a.w);
    const pick = parts.find((p: any) => p.w && p.w <= 1600) || parts[0];
    if (pick?.u) cands.push(pick.u);
  }
  for (const a of ["data-src", "data-original", "data-lazy-src", "src"]) {
    const v = img.getAttribute(a);
    if (v && !v.startsWith("data:")) cands.push(v);
  }
  for (const c of cands) {
    try { return kindleSized(new URL(c, base || undefined).toString()); } catch { /* next */ }
  }
  return "";
}

// Ask image CDNs for a Kindle-sized JPEG instead of the WebP they would send.
function kindleSized(src: string): string {
  const m = /^https:\/\/substackcdn\.com\/image\/fetch\/[^/]+\/(https?%3A.+)$/.exec(src);
  if (m) return `https://substackcdn.com/image/fetch/w_1072,c_limit,f_jpg,q_auto:good,fl_progressive:steep/${m[1]}`;
  return src;
}

async function fetchImage(src: string): Promise<{ data: Uint8Array; type: string; ext: string } | null> {
  const r = await fetch(src, { headers: { "user-agent": UA, accept: "image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error(`too big (${len} bytes)`);
  const data = new Uint8Array(await r.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`too big (${data.length} bytes)`);
  // Trust the bytes, not the header.
  if (data[0] === 0xff && data[1] === 0xd8) return { data, type: "image/jpeg", ext: "jpg" };
  if (data[0] === 0x89 && data[1] === 0x50) return { data, type: "image/png", ext: "png" };
  if (data[0] === 0x47 && data[1] === 0x49) return { data, type: "image/gif", ext: "gif" };
  return null;
}

/* ---------------- clean XHTML ---------------- */

const KEEP = new Set(["p", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "a", "em", "strong", "b", "i", "u", "s", "sub", "sup",
  "code", "pre", "figure", "figcaption", "img", "br", "hr", "table", "thead", "tbody", "tr", "th", "td", "dl", "dt", "dd", "cite", "q", "small",
  "abbr", "mark", "div", "aside"]);
const DROP = new Set(["script", "style", "noscript", "iframe", "form", "input", "button", "select", "textarea", "svg", "canvas", "video",
  "audio", "source", "object", "embed", "nav", "footer", "header", "template", "link", "meta"]);
const VOID = new Set(["img", "br", "hr"]);
const RENAME: Record<string, string> = { h1: "h2", section: "div", article: "div", main: "div", picture: "" };

function serialize(node: any, base: string, headings: Heading[]): string {
  let out = "";
  for (const child of Array.from(node.childNodes) as any[]) {
    if (child.nodeType === 3) { out += esc(child.textContent || ""); continue; }
    if (child.nodeType !== 1) continue;
    let tag = String(child.tagName || "").toLowerCase();
    if (DROP.has(tag)) continue;
    if (tag in RENAME) tag = RENAME[tag];
    if (child.getAttribute?.("data-ns-h") && (tag === "p" || tag === "div")) tag = "h2";
    if (!tag || !KEEP.has(tag)) { out += serialize(child, base, headings); continue; } // unwrap
    if (tag === "div" && !child.childNodes.length) continue;

    let attrs = "";
    if (tag === "a") {
      const href = child.getAttribute("href") || "";
      if (href.startsWith("#")) attrs = ` href="${esc(href)}"`;
      else if (href) { try { attrs = ` href="${esc(new URL(href, base || undefined).toString())}"`; } catch { /* drop */ } }
    } else if (tag === "img") {
      const src = child.getAttribute("data-ns-src");
      if (!src) continue;
      attrs = ` src="${esc(src)}" alt="${esc(child.getAttribute("alt") || "")}"`;
    } else if (tag === "td" || tag === "th") {
      for (const a of ["colspan", "rowspan"]) { const v = child.getAttribute(a); if (v && /^\d+$/.test(v)) attrs += ` ${a}="${v}"`; }
    } else if (tag === "aside") {
      tag = "div"; attrs = ` class="aside"`;
    }
    const id = child.getAttribute?.("id");
    if (/^h[2-6]$/.test(tag)) {
      const hid = `h${headings.length + 1}`;
      const text = (child.textContent || "").replace(/\s+/g, " ").trim();
      if (text) headings.push({ id: hid, level: Number(tag[1]), text: text.slice(0, 120) });
      attrs += ` id="${hid}"`;
    } else if (id && /^[A-Za-z][\w:.-]*$/.test(id)) {
      attrs += ` id="${esc(id)}"`; // keeps footnote anchors working
    }
    if (VOID.has(tag)) { out += `<${tag}${attrs}/>`; continue; }
    const inner = serialize(child, base, headings);
    if (!inner.trim() && tag !== "td" && tag !== "th") continue;
    out += `<${tag}${attrs}>${inner}</${tag}>`;
  }
  return out;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/* ---------------- AI clean-up (OpenAI Decisions) ---------------- */

const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "blockquote", "figure", "picture", "pre", "table", "img", "hr"]);
const CHOICES = [
  { value: "text", description: "Part of the article body: paragraphs, lists, quotes, code or tables that belong to the story." },
  { value: "heading", description: "A section heading inside the article body." },
  { value: "media", description: "An image or figure (or its caption) that belongs to the article." },
  { value: "promo", description: "Not the article: subscribe or sign-up boxes, share buttons, 'read more' or related posts, ads, sponsor messages, app prompts, comments, cookie or paywall notices." },
  { value: "navigation", description: "Not the article: site menus, breadcrumbs, tag lists, footers, author bio boxes, lists of links to other pages." },
  { value: "meta", description: "The article's own title, byline, date, reading time or share line. The e-book title page already shows these." },
];
const DROP_KINDS = new Set(["promo", "navigation", "meta"]);
const MIN_CONFIDENCE = 0.6;

function countWords(el: any): number {
  const t = (el?.textContent || "").replace(/\s+/g, " ").trim();
  return t ? t.split(" ").length : 0;
}

function collectBlocks(el: any, out: any[]) {
  for (const child of Array.from(el.children || []) as any[]) {
    const tag = String(child.tagName || "").toLowerCase();
    if (DROP.has(tag)) continue;
    if (BLOCKS.has(tag)) { out.push(child); continue; }
    if ((child.children || []).length) collectBlocks(child, out);
    else if ((child.textContent || "").trim()) out.push(child);
  }
}

function describe(el: any, i: number): string {
  const tag = String(el.tagName || "").toLowerCase();
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (tag === "img") return `[${i}] <img alt="${(el.getAttribute("alt") || "").slice(0, 120)}">`;
  const links = Array.from(el.querySelectorAll?.("a") || []) as any[];
  const linkChars = links.reduce((n, a) => n + (a.textContent || "").length, 0);
  const hints = [] as string[];
  if (el.querySelector?.("img")) hints.push("has image");
  if (text && linkChars / text.length > 0.6) hints.push("mostly links");
  const short = text.length > 420 ? text.slice(0, 300) + " … " + text.slice(-100) : text;
  return `[${i}] <${tag}>${hints.length ? " (" + hints.join(", ") + ")" : ""} ${short}`;
}

async function aiClean(root: any, ctx: { title: string; site: string; url: string; candidates: string[]; mode: "clean" | "rescue" }, key: string, log: Log): Promise<{ title?: string }> {
  const blocks: any[] = [];
  collectBlocks(root, blocks);
  if (!blocks.length) return {};
  const list = blocks.slice(0, 1600);
  const input = [
    {
      role: "developer",
      content: `You are preparing a web article for an e-reader. Each numbered block below is one piece of the page, in order. ` +
        (ctx.mode === "rescue"
          ? `This is the WHOLE page, not an extract: most blocks are site menus, promos and footers. Mark only the article itself as text, heading or media.`
          : `This is an extract that is mostly the article, with some leftovers (sign-up boxes, share lines, related links, the byline). Mark the leftovers.`) +
        ` When unsure, choose text.\nPage: "${ctx.title}" on ${ctx.site || "?"} (${ctx.url || "posted content"}).`,
    },
    { role: "user", content: list.map((b, i) => describe(b, i)).join("\n") },
  ];
  const questions: ChoiceQuestion[] = list.map((_, i) => ({ type: "choice", name: `b${i}`, instructions: `What is block [${i}]?`, choices: CHOICES }));
  if (ctx.candidates.length > 1) {
    questions.push({ type: "choice", name: "title", instructions: "Which of these is the article's real title (not the site name, not a slogan)?", choices: ctx.candidates.map((c) => ({ value: c })) });
  }
  const t0 = Date.now();
  const res = await decide(key, input, questions, `ns-${ctx.url || ctx.title}`.slice(0, 64));

  const counts: Record<string, number> = {};
  const dropped: string[] = [];
  let unsure = 0;
  list.forEach((b, i) => {
    const a = res.answers.get(`b${i}`);
    if (!a || !a.choice) return;
    counts[a.choice] = (counts[a.choice] || 0) + 1;
    if (DROP_KINDS.has(a.choice)) {
      if (a.confidence >= MIN_CONFIDENCE) {
        dropped.push(`${a.choice}: ${(b.textContent || b.getAttribute?.("alt") || "").replace(/\s+/g, " ").trim().slice(0, 70)}`);
        b.remove();
      } else unsure++;
    } else if (a.choice === "heading") {
      const tag = String(b.tagName || "").toLowerCase();
      if ((tag === "p" || tag === "div") && (b.textContent || "").trim().length < 110) b.setAttribute("data-ns-h", "1");
    }
  });
  const kept = list.length - dropped.length;
  await log("info", `AI clean-up (${ctx.mode}): kept ${kept} of ${list.length} blocks; ` +
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") +
    `; ${unsure} unsure kept · ${res.inputTokens} tokens (${res.cachedTokens} cached), ${res.calls} call(s), ${cost(res.inputTokens)}, ${Date.now() - t0} ms`);
  for (const d of dropped.slice(0, 25)) await log("info", `  dropped ${d}`);
  if (dropped.length > 25) await log("info", `  … and ${dropped.length - 25} more`);
  const t = res.answers.get("title");
  if (t?.choice && t.confidence >= 0.5 && t.choice !== ctx.title) {
    await log("info", `AI title: "${t.choice}"`);
    return { title: t.choice };
  }
  return {};
}
