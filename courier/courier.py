#!/usr/bin/env python3
"""Nightstand courier: connects a local Shelfmark to the Nightstand server.

Loop:
  1. GET  {SERVER}/courier/next?wait=N           long poll: returns as soon as there is work
     - searches: ask Shelfmark (metadata -> releases), POST the list to /courier/searches/<id>
     - jobs: queue the release the user picked (or find the best one), in Shelfmark
  2. Follow each Shelfmark task (GET /api/status); POST progress to /courier/jobs/<id>/progress
  3. When done: fetch the file (GET /api/localdownload), convert AZW3/MOBI to EPUB
  4. POST {SERVER}/courier/jobs/<id>/file        the server checks it (DRM, right book) and delivers it
     or  {SERVER}/courier/jobs/<id>/fail         with a plain reason

Shelfmark's release sources are whatever its admin has enabled. This script
does not enable or configure any source.

Config (environment): NIGHTSTAND_URL, COURIER_KEY, SHELFMARK_URL (default
http://127.0.0.1:8084), SHELFMARK_API_KEY (optional), STATE (JSON file path).
Standard library only.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

SERVER = os.environ["NIGHTSTAND_URL"].rstrip("/")
COURIER_KEY = os.environ["COURIER_KEY"]
SHELFMARK = os.environ.get("SHELFMARK_URL", "http://127.0.0.1:8084").rstrip("/")
SM_KEY = os.environ.get("SHELFMARK_API_KEY", "")
STATE = os.environ.get("STATE", "/srv/books/courier/state.json")
POLL = int(os.environ.get("POLL", "30"))
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT", str(45 * 60)))  # give up on a download after this
UA = "nightstand-courier/1.0"
FORMATS = ["epub", "azw3", "mobi"]  # preference order; others are skipped


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def http(method: str, url: str, headers: dict | None = None, body: bytes | None = None, timeout: int = 60) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers={"user-agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ---------------- Nightstand server ----------------

def ns(method: str, path: str, payload=None, raw: bytes | None = None, extra: dict | None = None):
    h = {"authorization": f"Bearer {COURIER_KEY}", **(extra or {})}
    body = raw
    if payload is not None:
        body = json.dumps(payload).encode()
        h["content-type"] = "application/json"
    code, data = http(method, SERVER + path, h, body, timeout=120)
    try:
        return code, json.loads(data or b"{}")
    except ValueError:
        return code, {"raw": data[:200].decode(errors="replace")}


def note(job_id: str, msg: str) -> None:
    log(f"[{job_id}] {msg}")
    ns("POST", f"/courier/jobs/{job_id}/log", {"msg": msg})


def fail(job_id: str, reason: str) -> None:
    log(f"[{job_id}] FAIL {reason}")
    ns("POST", f"/courier/jobs/{job_id}/fail", {"reason": reason})


# ---------------- Shelfmark ----------------

def sm(path: str, payload=None):
    h = {"x-api-key": SM_KEY} if SM_KEY else {}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        h["content-type"] = "application/json"
    code, data = http("POST" if payload is not None else "GET", SHELFMARK + path, h, body, timeout=120)
    try:
        return code, json.loads(data or b"{}")
    except ValueError:
        return code, {}


def words(s: str) -> list[str]:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    stop = {"the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "by", "with", "novel", "book"}
    return [w for w in re.split(r"[^a-z0-9]+", s) if w and w not in stop]


def match(have_title: str, have_author: str, want_title: str, want_author: str) -> float:
    main = words(re.split(r"[:;(]", want_title or "")[0])
    if not main:
        return 0.0
    got = set(words(have_title))
    score = sum(w in got for w in main) / len(main)
    last = (words(want_author) or [""])[-1]
    if last and last not in words(have_author):
        score *= 0.4
    return score


def pick_book(job: dict) -> dict | None:
    q = " ".join(x for x in [job.get("title"), job.get("author")] if x) or job.get("query", "")
    code, d = sm("/api/metadata/search?" + urllib.parse.urlencode({"query": q}))
    if code != 200:
        raise RuntimeError(f"Shelfmark metadata search returned HTTP {code}")
    books = d.get("books") or []

    def author_of(b: dict) -> str:
        return b.get("author") or " ".join(b.get("authors") or [])

    if job.get("title"):
        scored = [(match(b.get("title", ""), author_of(b), job["title"], job.get("author") or ""), b) for b in books]
    else:
        # Query only ("middlemarch george eliot"): the result's main title must be in the query.
        qw = set(words(q))
        scored = []
        for b in books:
            tw = words(re.split(r"[:;(]", b.get("title", ""))[0])
            scored.append((sum(w in qw for w in tw) / len(tw) if tw else 0.0, b))
    best = max(scored, key=lambda x: x[0], default=(0.0, None))  # ties keep Shelfmark's order
    return best[1] if best[0] >= 0.6 else None


def size_mb(s) -> float:
    m = re.match(r"([\d.]+)\s*([KMG]?B)", str(s or ""), re.I)
    if not m:
        return 0.0
    return float(m.group(1)) * {"B": 1e-6, "KB": 1e-3, "MB": 1, "GB": 1e3}[m.group(2).upper()]


def releases_for(book: dict, n: int = 6) -> list[dict]:
    params = {"provider": book.get("provider", ""), "book_id": book.get("provider_id", ""), "content_type": "ebook"}
    code, d = sm("/api/releases?" + urllib.parse.urlencode(params))
    if code != 200:
        raise RuntimeError(f"Shelfmark releases returned HTTP {code}")
    rel = [r for r in d.get("releases") or [] if (r.get("format") or "").lower() in FORMATS]
    rel = [r for r in rel if size_mb(r.get("size")) == 0 or 0.05 <= size_mb(r.get("size")) <= 60]
    rel.sort(key=lambda r: (FORMATS.index(r["format"].lower()), -size_mb(r.get("size"))))
    return rel[:n]


def pick_release(book: dict) -> dict | None:
    rel = releases_for(book, 1)
    return rel[0] if rel else None


def task_status(task_id: str) -> dict | None:
    code, d = sm("/api/status")
    if code != 200:
        return None
    for tasks in d.values():
        if isinstance(tasks, dict) and task_id in tasks:
            return tasks[task_id]
    return None


def fetch_file(task_id: str, dest_dir: str) -> str:
    h = {"x-api-key": SM_KEY} if SM_KEY else {}
    req = urllib.request.Request(f"{SHELFMARK}/api/localdownload?id={urllib.parse.quote(task_id)}", headers={"user-agent": UA, **h})
    with urllib.request.urlopen(req, timeout=300) as r:
        cd = r.headers.get("content-disposition", "")
        m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', cd)
        name = urllib.parse.unquote(m.group(1)) if m else f"{task_id}.bin"
        path = os.path.join(dest_dir, os.path.basename(name))
        with open(path, "wb") as f:
            shutil.copyfileobj(r, f)
    return path


def to_epub(path: str) -> str:
    if path.lower().endswith(".epub"):
        return path
    if not shutil.which("ebook-convert"):
        raise RuntimeError(f"got {os.path.splitext(path)[1]} and Calibre's ebook-convert is not installed")
    out = os.path.splitext(path)[0] + ".epub"
    subprocess.run(["ebook-convert", path, out], check=True, capture_output=True, timeout=600)
    return out


# ---------------- state ----------------

def load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(s: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE)


# ---------------- main loop ----------------

def do_search(srch: dict) -> None:
    sid, q = srch["id"], srch.get("query", "")
    try:
        book = pick_book({"query": q})
        if not book:
            ns("POST", f"/courier/searches/{sid}", {"error": "no matching book in Shelfmark's metadata"})
            return
        rels = releases_for(book)
        out = [{**r, "source_display": r.get("source_display_name") or r.get("source")} for r in rels]
        author = book.get("author") or ", ".join(book.get("authors") or [])
        ns("POST", f"/courier/searches/{sid}", {"book": {"title": book.get("title"), "author": author}, "releases": out})
        log(f"search '{q}': {len(out)} releases")
    except Exception as e:  # noqa: BLE001
        ns("POST", f"/courier/searches/{sid}", {"error": str(e)[:200]})


def start(job: dict, state: dict) -> None:
    jid = job["id"]
    rel = job.get("release")
    if not rel:
        book = pick_book(job)
        if not book:
            return fail(jid, f'Shelfmark could not identify "{job.get("title") or job.get("query")}"')
        note(jid, f'identified: "{book.get("title")}" ({book.get("provider")}:{book.get("provider_id")})')
        rel = pick_release(book)
        if not rel:
            return fail(jid, "Shelfmark found no EPUB/AZW3/MOBI release in its enabled sources")
    code, d = sm("/api/releases/download", {k: v for k, v in rel.items() if k != "source_display"})
    if code != 200:
        return fail(jid, f"Shelfmark would not queue the release: {d.get('error', code)}")
    state[jid] = {"task": rel["source_id"], "since": time.time(), "fmt": rel.get("format"), "pct": -1}
    note(jid, f'queued release: {rel.get("format")} {rel.get("size") or ""} via {rel.get("source_display") or rel.get("source")}')
    progress(jid, 0, "Requested")


def progress(jid: str, pct: float, label: str) -> None:
    ns("POST", f"/courier/jobs/{jid}/progress", {"pct": round(pct, 1), "note": label})


def check(jid: str, info: dict, state: dict) -> None:
    t = task_status(info["task"])
    st = (t or {}).get("status")
    if st in ("queued", "resolving", "locating", "downloading"):
        p = float((t or {}).get("progress") or 0)
        pct = p * 100 if p <= 1 else p
        label = {"queued": "Requested", "resolving": "Finding a copy", "locating": "Finding a copy", "downloading": "Downloading"}[st]
        if abs(pct - info.get("pct", -1)) >= 5 or label != info.get("label"):
            progress(jid, pct, label)
            info["pct"], info["label"] = pct, label
    if st == "complete":
        progress(jid, 100, "Checking")
        with tempfile.TemporaryDirectory() as tmp:
            try:
                path = to_epub(fetch_file(info["task"], tmp))
            except Exception as e:  # noqa: BLE001
                fail(jid, f"could not prepare the file: {e}")
                state.pop(jid, None)
                return
            with open(path, "rb") as f:
                data = f.read()
            code, d = ns("POST", f"/courier/jobs/{jid}/file", raw=data,
                         extra={"content-type": "application/epub+zip", "x-filename": os.path.basename(path)})
            log(f"[{jid}] upload -> HTTP {code} {d}")
        state.pop(jid, None)
    elif st in ("error", "cancelled"):
        fail(jid, f"Shelfmark download {st}: {(t or {}).get('status_message') or 'no detail'}")
        state.pop(jid, None)
    elif time.time() - info["since"] > JOB_TIMEOUT:
        fail(jid, f"download did not finish in {JOB_TIMEOUT // 60} minutes (last status: {st or 'unknown'})")
        state.pop(jid, None)


def tick(state: dict) -> None:
    # Short wait while downloads run (progress updates), long wait when idle.
    wait = 4 if state else 20
    code, d = ns("GET", f"/courier/next?wait={wait}")
    if code != 200:
        log(f"server /courier/next -> HTTP {code} {d}")
        time.sleep(10)
        return
    for srch in d.get("searches", []):
        do_search(srch)
    for job in d.get("jobs", []):
        if job["id"] in state:
            continue
        try:
            start(job, state)
        except Exception as e:  # noqa: BLE001
            fail(job["id"], f"courier error: {e}")
    for jid, info in list(state.items()):
        try:
            check(jid, info, state)
        except Exception as e:  # noqa: BLE001
            log(f"[{jid}] check error: {e}")


def main() -> None:
    log(f"courier up: server {SERVER}, shelfmark {SHELFMARK} (long poll)")
    state = load_state()
    while True:
        try:
            tick(state)
        except Exception as e:  # noqa: BLE001  (network blips must not kill the loop)
            log(f"tick error: {e}")
            time.sleep(10)
        save_state(state)
        if "--once" in sys.argv:
            return


if __name__ == "__main__":
    main()
