#!/usr/bin/env python3
"""
Bygger en publiseringsklar kopi av nettsiden i mappen dist/.

    python3 bygg.py

Kildefilene (index.html, personvern.html, 404.html) beholder guiden og alle
kommentarene, så de er lette å redigere. Kopien i dist/ får kommentarene og
innrykkene fjernet, så «Vis kilde» på dotdev.no ser ryddig ut. Selve siden
ser og virker helt likt.

Netlify kjører skriptet selv ved hver publisering fra GitHub og publiserer
bare dist/ (se netlify.toml). Kjør det lokalt bare hvis du vil se resultatet.

Skriptet lager også dist/_headers: sikkerhetsreglene (Content-Security-Policy)
får en sha256-hash for hvert innebygde <script> og <style>, så nettleseren
bare kjører koden vi selv har skrevet. Se «Sikkerhet» i LES-MEG.md.
"""

import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"

HTML_FILES = ["index.html", "personvern.html", "404.html", "kunde.html"]
COPY = [
    "robots.txt", "sitemap.xml", "site.webmanifest", ".well-known",
    "favicon.ico", "favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
    "delingsbilde.png", "fonter", "bilder",
]
# _headers kopieres ikke rett over: write_headers() fyller inn hashene først.
HASH_SCRIPT = "HASHER-FOR-SKRIPT"
HASH_STYLE = "HASHER-FOR-STIL"


# ── JavaScript: fjern kommentarer, innrykk og tomme linjer ─────────────────
# En enkel tokeniserer som kjenner strenger, malstrenger (`…${…}…`) og regulære
# uttrykk, så ingenting inni dem blir tolket som kommentarer.

KEYWORDS_BEFORE_REGEX = {
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "case", "do", "else", "yield", "await",
}


def _regex_allowed(prev):
    """Kan en / her starte et regulært uttrykk (og ikke være deling)?"""
    if prev in ("", "kw"):
        return True
    if prev in ("id", "num", "str", "regex"):
        return False
    return prev not in ("punct:)", "punct:]", "punct:}")


def strip_js(src):
    def fail(msg, pos):
        line = src.count("\n", 0, pos) + 1
        raise ValueError(f"{msg} (linje {line} i skriptet: {src.splitlines()[line - 1].strip()[:90]})")

    out = []
    i, n = 0, len(src)
    braces = []          # krøllparentes-dybde inni hver ${ … } i malstrenger
    in_template = False
    prev = ""

    def newline():
        while out and out[-1] == " ":
            out.pop()
        if out and out[-1] != "\n":
            out.append("\n")

    while i < n:
        c = src[i]

        if in_template:
            if c == "\\":
                out.append(src[i:i + 2]); i += 2
            elif c == "`":
                out.append(c); i += 1; in_template = False; prev = "str"
            elif src.startswith("${", i):
                out.append("${"); i += 2; braces.append(0); in_template = False; prev = "punct:{"
            else:
                out.append(c); i += 1
            continue

        if c in " \t":
            while i < n and src[i] in " \t":
                i += 1
            if out and out[-1] not in ("\n", " "):
                out.append(" ")
            continue
        if c in "\r\n":
            while i < n and src[i] in "\r\n":
                i += 1
            newline()
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            if j == -1:
                fail("Uavsluttet /* … */-kommentar i JavaScript", i)
            if "\n" in src[i:j]:
                newline()
            elif out and out[-1] not in ("\n", " "):
                out.append(" ")
            i = j + 2
            continue
        if c in "\"'":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\n":
                    fail("Linjeskift inni en streng i JavaScript", i)
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1]); i = j + 1; prev = "str"
            continue
        if c == "`":
            out.append(c); i += 1; in_template = True
            continue
        if c == "/" and _regex_allowed(prev):
            j, in_class = i + 1, False
            while j < n:
                ch = src[j]
                if ch == "\\":
                    j += 2; continue
                if ch == "\n":
                    fail("Linjeskift inni et regulært uttrykk i JavaScript", i)
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            out.append(src[i:j]); i = j; prev = "regex"
            continue
        if c == "{":
            if braces:
                braces[-1] += 1
            out.append(c); i += 1; prev = "punct:{"
            continue
        if c == "}":
            if braces:
                if braces[-1] == 0:
                    braces.pop(); out.append(c); i += 1; in_template = True
                    continue
                braces[-1] -= 1
            out.append(c); i += 1; prev = "punct:}"
            continue
        if c.isalpha() or c in "_$" or ord(c) > 127:
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$" or ord(src[j]) > 127):
                j += 1
            word = src[i:j]
            out.append(word); i = j
            prev = "kw" if word in KEYWORDS_BEFORE_REGEX else "id"
            continue
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            j = i
            while j < n and (src[j].isalnum() or src[j] in "._"):
                j += 1
            out.append(src[i:j]); i = j; prev = "num"
            continue
        out.append(c); i += 1; prev = "punct:" + c

    if in_template or braces:
        raise ValueError("Uavsluttet malstreng i JavaScript")
    return "".join(out).strip("\n") + "\n"


# ── CSS og HTML ─────────────────────────────────────────────────────────────

def strip_css(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    lines = (line.strip() for line in css.splitlines())
    return "\n".join(line for line in lines if line) + "\n"


def strip_markup(html):
    lines = (line.strip() for line in html.splitlines())
    return "\n".join(line for line in lines if line)


# Det som kommer først av en HTML-kommentar og et element der innholdet ikke er
# vanlig HTML. Kommentarer fjernes før vi leter etter <script> osv., ellers kunne
# ordet «<script>» inni guiden bli tolket som et ekte skript.
NEXT = re.compile(r"<!--|<(script|style|textarea|pre)\b", re.I)


def split_html(src):
    """Gir (markup, blokk)-deler: markup uten kommentarer, og hele rå-blokker."""
    parts, pos, buf = [], 0, []
    while True:
        m = NEXT.search(src, pos)
        if not m:
            buf.append(src[pos:])
            parts.append(("markup", "".join(buf)))
            return parts
        buf.append(src[pos:m.start()])
        if m.group(0) == "<!--":
            end = src.find("-->", m.end())
            if end == -1:
                raise ValueError("Uavsluttet HTML-kommentar")
            pos = end + 3
            continue
        name = m.group(1).lower()
        end = re.compile(r"</" + name + r"\s*>", re.I).search(src, m.end())
        if not end:
            raise ValueError(f"Fant ikke </{name}>")
        parts.append(("markup", "".join(buf)))
        buf = []
        parts.append(("block", src[m.start():end.end()]))
        pos = end.end()


def build_html(src, scripts):
    parts = []
    for kind, part in split_html(src):
        if kind == "markup":
            parts.append(strip_markup(part))
            continue
        open_tag = part[:part.index(">") + 1]
        name = re.match(r"<(\w+)", open_tag).group(1).lower()
        inner = part[len(open_tag):part.rindex("</")]
        if name == "style":
            parts.append(open_tag + "\n" + strip_css(inner) + "</style>")
        elif name == "script" and "ld+json" in open_tag:
            data = json.dumps(json.loads(inner), ensure_ascii=False, separators=(",", ":"))
            parts.append(open_tag + data + "</script>")
        elif name == "script":
            js = strip_js(inner)
            scripts.append(js)
            parts.append(open_tag + "\n" + js + "</script>")
        else:
            parts.append(part)
    return "\n".join(p for p in parts if p) + "\n"


# ── Kontroller ──────────────────────────────────────────────────────────────

def check_js(scripts):
    """Syntakssjekk med Node.js hvis det er installert (valgfritt)."""
    node = shutil.which("node")
    if not node:
        print("  (Node.js finnes ikke, så JavaScript-syntaksen ble ikke sjekket)")
        return
    for js in scripts:
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(js)
            tmp = f.name
        try:
            res = subprocess.run([node, "--check", tmp], capture_output=True, text=True)
            if res.returncode != 0:
                sys.exit("Feil i JavaScript etter bygging:\n" + res.stderr)
        finally:
            Path(tmp).unlink(missing_ok=True)
    print(f"  JavaScript-syntaks OK ({len(scripts)} skript)")


# ── Sikkerhetsregler: hasher for innebygd kode ────────────────────────────
# Nettleseren regner ut sha256 av teksten mellom <script> og </script> (og det
# samme for <style>) og kjører den bare hvis hashen står i CSP-en. Hashene regnes
# ut fra filene slik de ligger i dist/, byte for byte, så de alltid stemmer.

INLINE = re.compile(r"<(script|style)\b([^>]*)>(.*?)</\1\s*>", re.S | re.I)
# Inline-hendelser (onclick= o.l.), style="…" og javascript:-lenker blir stoppet
# av CSP-en. Byggingen stopper heller her, så det ikke blir en side som ikke virker.
FORBIDDEN = re.compile(r"<[^>]*\s(?:on[a-z]+|style)\s*=|javascript:", re.I)
# Skript med src= (egen fil) og JSON-LD (data, kjøres ikke) trenger ingen hash
EXTERNAL = re.compile(r"(?:^|\s)src\s*=", re.I)
JSON_LD = re.compile(r"(?:^|\s)type\s*=\s*[\"']?application/ld\+json", re.I)


def csp_hash(body):
    # Nettleseren gjør CRLF og CR om til LF før den regner ut hashen (HTML-standarden),
    # så det samme gjøres her. Ellers blir hashene feil hvis siden bygges på Windows.
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    digest = hashlib.sha256(body.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


def inline_hashes(name, html):
    """Gir (skript-hasher, stil-hasher) for én side og stopper ved inline-attributter."""
    found = FORBIDDEN.search(INLINE.sub("", html))
    if found:
        sys.exit(f"{name}: «{found.group(0)[:60]}» blir stoppet av sikkerhetsreglene (CSP). "
                 "Flytt koden inn i <script>/<style>-blokken i stedet.")
    scripts, styles = set(), set()
    for tag, attrs, body in INLINE.findall(html):
        if tag.lower() == "style":
            styles.add(csp_hash(body))
        elif not EXTERNAL.search(attrs) and not JSON_LD.search(attrs):
            scripts.add(csp_hash(body))
    return scripts, styles


def write_headers(scripts, styles):
    if not scripts or not styles:
        sys.exit("Fant ingen innebygde skript eller stiler å lage hasher for")
    text = (ROOT / "_headers").read_text(encoding="utf-8")
    for marker, hashes in ((HASH_SCRIPT, scripts), (HASH_STYLE, styles)):
        if text.count(marker) != 1:
            sys.exit(f"_headers må inneholde {marker} nøyaktig én gang (i Content-Security-Policy)")
        text = text.replace(marker, " ".join(sorted(hashes)))
    with open(DIST / "_headers", "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"  Sikkerhetsregler: {len(scripts)} skript og {len(styles)} stiler med hash i _headers")


def main():
    if DIST == ROOT or ROOT not in DIST.parents:
        sys.exit("Ugyldig dist-mappe")
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    scripts = []
    before = after = 0
    for name in HTML_FILES:
        src = (ROOT / name).read_text(encoding="utf-8")
        html = build_html(src, scripts)
        (DIST / name).write_text(html, encoding="utf-8")
        before += len(src.encode("utf-8"))
        after += len(html.encode("utf-8"))

    for name in COPY:
        path = ROOT / name
        if path.is_dir():
            shutil.copytree(path, DIST / name)
        elif path.exists():
            shutil.copy2(path, DIST / name)
        else:
            print(f"  Advarsel: fant ikke {name}")

    check_js(scripts)

    # Hashene regnes ut fra filene slik de ble skrevet (bytes, uten linjeskift-omgjøring)
    all_scripts, all_styles = set(), set()
    for name in HTML_FILES:
        page_scripts, page_styles = inline_hashes(name, (DIST / name).read_bytes().decode("utf-8"))
        all_scripts |= page_scripts
        all_styles |= page_styles
    write_headers(all_scripts, all_styles)

    print(f"  HTML: {before / 1024:.0f} KB → {after / 1024:.0f} KB (uten kommentarer og innrykk)")
    print(f"\nFerdig! Publiseringsklar kopi i:\n  {DIST}")


if __name__ == "__main__":
    main()
