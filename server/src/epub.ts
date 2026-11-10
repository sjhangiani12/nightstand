// Pack a converted article into a standard EPUB 3 (with an EPUB 2 NCX for
// older readers). The mimetype entry must come first and be uncompressed.
import { zipSync, strToU8, type Zippable } from "fflate";
import { esc, type Article } from "./articles";

const CSS = `
body { margin: 0; padding: 0; font-family: serif; line-height: 1.5; }
h1 { font-size: 1.6em; line-height: 1.15; margin: 0 0 0.4em; }
h2 { font-size: 1.3em; line-height: 1.2; margin: 1.4em 0 0.5em; }
h3, h4, h5, h6 { font-size: 1.1em; margin: 1.2em 0 0.4em; }
p { margin: 0 0 0.9em; text-align: left; }
blockquote, .aside { margin: 1em 0 1em 1em; padding-left: 0.8em; border-left: 2px solid #000; }
figure { margin: 1.2em 0; text-align: center; }
img { max-width: 100%; height: auto; }
figcaption { font-size: 0.85em; margin-top: 0.4em; }
pre, code { font-family: monospace; font-size: 0.85em; }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
td, th { border: 1px solid #000; padding: 0.3em; vertical-align: top; }
a { color: #000; }
.titlepage { margin-top: 30%; }
.kicker { font-family: sans-serif; font-size: 0.75em; letter-spacing: 0.08em; text-transform: uppercase; }
.meta { font-family: sans-serif; font-size: 0.85em; margin-top: 1.2em; }
.source { font-family: sans-serif; font-size: 0.75em; margin-top: 2em; word-break: break-all; }
`;

function page(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body>
</html>`;
}

export function buildEpub(a: Article, id: string): Uint8Array {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const metaLine = [a.author, a.site, a.published, `${a.minutes} min read`].filter(Boolean).map(esc).join(" · ");

  const title = page(a.title, `<div class="titlepage"><p class="kicker">${esc(a.site || "Article")}</p><h1>${esc(a.title)}</h1>` +
    `<p class="meta">${metaLine}</p>${a.excerpt ? `<p class="meta"><em>${esc(a.excerpt)}</em></p>` : ""}</div>`);
  const text = page(a.title, `<h1 id="start">${esc(a.title)}</h1>${a.xhtml}` +
    (a.url ? `<p class="source">Source: <a href="${esc(a.url)}">${esc(a.url)}</a></p>` : ""));

  const navItems = [`<li><a href="text.xhtml#start">${esc(a.title)}</a></li>`]
    .concat(a.headings.filter((h) => h.level <= 3).map((h) => `<li><a href="text.xhtml#${h.id}">${esc(h.text)}</a></li>`));
  const nav = page("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.join("")}</ol></nav>`);

  const ncxPoints = [{ id: "start", text: a.title }].concat(a.headings.filter((h) => h.level <= 3).map((h) => ({ id: h.id, text: h.text })))
    .map((p, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(p.text)}</text></navLabel><content src="text.xhtml#${p.id}"/></navPoint>`)
    .join("");
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:nightstand:${id}"/></head>
<docTitle><text>${esc(a.title)}</text></docTitle><navMap>${ncxPoints}</navMap></ncx>`;

  const coverItem = a.cover ? `<item id="cover" href="images/${a.cover.name}" media-type="${a.cover.type}" properties="cover-image"/>` : "";
  const imgItems = a.images.map((im, i) => `<item id="im${i + 1}" href="images/${im.name}" media-type="${im.type}"/>`).join("");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:nightstand:${id}</dc:identifier>
<dc:title>${esc(a.title)}</dc:title>
<dc:language>en</dc:language>
${a.author ? `<dc:creator>${esc(a.author)}</dc:creator>` : ""}
${a.site ? `<dc:publisher>${esc(a.site)}</dc:publisher>` : ""}
${a.url ? `<dc:source>${esc(a.url)}</dc:source>` : ""}
${a.published ? `<dc:date>${esc(a.published)}</dc:date>` : ""}
<meta property="dcterms:modified">${now}</meta>
<meta name="nightstand:minutes" content="${a.minutes}"/>
${a.cover ? `<meta name="cover" content="cover"/>` : ""}
<meta name="nightstand:words" content="${a.words}"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
<item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
${coverItem}
${imgItems}
</manifest>
<spine toc="ncx"><itemref idref="title"/><itemref idref="text"/></spine>
</package>`;

  const files: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/toc.ncx": strToU8(ncx),
    "OEBPS/style.css": strToU8(CSS),
    "OEBPS/title.xhtml": strToU8(title),
    "OEBPS/text.xhtml": strToU8(text),
  };
  for (const im of a.images) files[`OEBPS/images/${im.name}`] = [im.data, { level: 0 }]; // already compressed
  if (a.cover) files[`OEBPS/images/${a.cover.name}`] = [a.cover.data, { level: 0 }];
  return zipSync(files, { level: 6 });
}
