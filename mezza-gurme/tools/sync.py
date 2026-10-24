#!/usr/bin/env python3
"""Pull the live menu from mezzagurme.com and rebuild data/menu.js + photos.

The restaurant keeps editing its menu in the existing admin panel; this script
reads the public menu pages (all 5 languages), merges them by item id, applies
the corrections from tools/overrides.json and writes everything the static
menu needs. Run it after every menu change (or on a schedule):

    python3 tools/sync.py            # fetch live data
    python3 tools/sync.py --src DIR  # reuse saved pages DIR/menu.<lang>.html

Requires Python 3.9+ and Pillow (pip install pillow).
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import unicodedata
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mezzagurme.com"
LANGS = ["tr", "en", "ru", "pl", "de"]
LANG_PATH = {"tr": "/menu", "en": "/en/menu", "ru": "/ru/menu", "pl": "/pl/menu", "de": "/de/menu"}
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

# Same grouping the restaurant site uses (category -> section of the menu).
GROUP_OF = {
    "Kendi Kahvaltını Yarat": "breakfast", "Kahvaltı Çeşitleri": "breakfast", "Omletler": "breakfast",
    "Açık Tostlar": "breakfast", "Tostlar": "breakfast",
    "Başlangıçlar": "starters", "Mezeler": "starters", "Salatalar": "starters",
    "Peynir & Şarküteri Tahtaları": "starters",
    "Ana Yemekler": "mains", "Pizzalar": "mains", "Bafra Pideleri": "mains", "Burgerler": "mains",
    "Makarnalar": "mains", "Bowl": "mains", "Çocuk Menüsü": "mains",
    "Tatlılar": "sweets",
    "Soğuk İçecekler": "drinks", "Sıcak İçecekler": "drinks", "Bitki Çayları": "drinks",
    "Biralar": "bar", "Kokteyller": "bar", "Şaraplar": "bar", "Rakılar": "bar", "Sert İçecekler": "bar",
}
GROUP_ORDER = ["breakfast", "starters", "mains", "sweets", "drinks", "bar", "other"]

# Brand copy reused from the restaurant's own site, per language.
MESSAGE_KEYS = {
    "menu": ["eyebrow", "title", "titleItalic", "siyezBadge", "serviceBetween", "serviceUntil", "closedNow"],
    "menuGroups": GROUP_ORDER,
    "allergens": ["label"],
    "footer": ["tagline", "tagline2"],
    "home": ["claim1Title", "claim1Desc", "claim2Title", "claim2Desc", "claim3Title", "claim3Desc",
             "claim4Title", "claim4Desc", "siyezEyebrow", "siyezTitle", "siyezTitleEm", "siyezBody1",
             "featuredEyebrow", "featuredTitle", "venueEyebrow", "venueTitle", "venueTitleEm", "venueBody"],
    "contact": ["title", "titleItalic", "reservationCta", "rateUs", "instagramRestaurant", "instagramMarket"],
    "whatsapp": ["orderMessage"],
    "form": ["waIntro"],
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "tr,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def rsc_payload(html):
    """Concatenate the React Server Components stream embedded in a Next.js page."""
    parts = []
    for chunk in re.findall(r"self\.__next_f\.push\((\[.*?\])\)</script>", html, re.S):
        try:
            arr = json.loads(chunk)
        except ValueError:
            continue
        if len(arr) > 1 and isinstance(arr[1], str):
            parts.append(arr[1])
    return "".join(parts)


def find_dicts_with(node, key):
    if isinstance(node, dict):
        if key in node:
            yield node
        for v in node.values():
            yield from find_dicts_with(v, key)
    elif isinstance(node, list):
        for v in node:
            yield from find_dicts_with(v, key)


def parse_page(html):
    payload = rsc_payload(html)
    props = None
    for line in payload.split("\n"):
        m = re.match(r"^[0-9a-f]+:(\[.*)$", line, re.S)
        if not m or '"items":[' not in line:
            continue
        try:
            tree = json.loads(m.group(1))
        except ValueError:
            continue
        for d in find_dicts_with(tree, "items"):
            if "categoryNames" in d:
                props = d
    if props is None:
        raise SystemExit("menu data not found in page — did the site change?")
    i = payload.find('"messages":')
    messages, _ = json.JSONDecoder().raw_decode(payload[i + len('"messages":'):])
    return props, messages


def slugify(s):
    s = s.replace("ı", "i").replace("İ", "i")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def tr_lower(s):
    return s.replace("I", "ı").replace("İ", "i").lower()


def tidy(text, lang, replace, is_desc=False):
    """Fix spacing/punctuation slips that the admin panel lets through."""
    if not text:
        return ""
    s = text
    for a, b in replace:
        s = re.sub(a, b, s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s+\)", ")", s)
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    s = re.sub(r",(?=[^\s\d])", ", ", s)
    s = re.sub(r"\.{2,}(?!\.)", ".", s) if "…" not in s else s
    s = re.sub(r"\s*…$", "…", s)
    letters = [c for c in s if c.isalpha()]
    if is_desc and lang == "tr" and len(letters) >= 8 and sum(c.isupper() for c in letters) / len(letters) > 0.7:
        low = tr_lower(s)
        s = low
    if is_desc and s[:1].islower():
        s = ({"i": "İ", "ı": "I"}.get(s[0], s[0].upper()) if lang == "tr" else s[0].upper()) + s[1:]
    return s


def parse_price(p):
    digits = re.sub(r"[^\d]", "", p or "")
    return int(digits) if digits else None


VOL_RE = re.compile(r"\s*\(?\s*(\d+)\s*cl\s*\)?\s*$", re.I)


def split_volume(name):
    m = VOL_RE.search(name)
    if not m:
        return name, None
    return name[: m.start()].strip(), f"{int(m.group(1))} cl"


def base_key(name):
    return re.sub(r"[^a-z0-9]+", "", slugify(name))


def variant_key(it, base, vol):
    """Sizes of one product merge into a single card only if every language describes them the same."""
    if not vol:
        return ("#%d" % it["n"],)
    return (base_key(base),) + tuple(it["desc"][l] for l in LANGS)


def ensure_photo(h, photos_dir, src):
    """Download the original photo once, make a card-size thumb and a placeholder colour."""
    full = os.path.join(photos_dir, f"{h}.webp")
    thumb = os.path.join(photos_dir, "s", f"{h}.webp")
    if not os.path.exists(full):
        data = fetch(SITE + src)
        with open(full, "wb") as f:
            f.write(data)
    im = Image.open(full).convert("RGB")
    if not os.path.exists(thumb):
        t = im.copy()
        t.thumbnail((480, 480), Image.LANCZOS)
        t.save(thumb, "WEBP", quality=72, method=6)
    r, g, b = im.resize((1, 1), Image.BOX).getpixel((0, 0))
    k = 0.55  # keep placeholders dark so they sit quietly on the page
    return "#%02x%02x%02x" % (int(r * k), int(g * k), int(b * k)), im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="directory with saved menu.<lang>.html pages (skip network)")
    args = ap.parse_args()

    with open(os.path.join(ROOT, "tools", "overrides.json"), encoding="utf-8") as f:
        ov = json.load(f)
    replace = ov.get("replace", [])

    pages = {}
    for lang in LANGS:
        if args.src:
            with open(os.path.join(args.src, f"menu.{lang}.html"), encoding="utf-8") as f:
                html = f.read()
        else:
            html = fetch(f"{SITE}{LANG_PATH[lang]}").decode("utf-8")
        pages[lang] = parse_page(html)
        print(f"{lang}: {len(pages[lang][0]['items'])} items", file=sys.stderr)

    base_props = pages["tr"][0]
    by_lang = {l: {it["id"]: it for it in pages[l][0]["items"]} for l in LANGS}

    # ---- items -----------------------------------------------------------
    raw_items = []
    sources = {}  # photo hash -> path on the restaurant site
    for it in base_props["items"]:
        num = it["number"]
        fix = ov.get("items", {}).get(str(num), {})
        name, desc = {}, {}
        for l in LANGS:
            src = by_lang[l].get(it["id"], it)
            name[l] = tidy(fix.get(l, {}).get("name") or src["name"], l, replace)
            desc[l] = tidy(fix.get(l, {}).get("desc") or src.get("description") or "", l, replace, True)
        img = re.search(r"/uploads/([\w-]+)/([0-9a-f]+)\.webp$", it.get("image") or "")
        if img:
            sources[img.group(2)] = img.group(0)
        raw_items.append({
            "n": num, "cat": it["category"], "order": it.get("order", 0),
            "price": parse_price(it.get("price")), "img": img.group(2) if img else None,
            "siyez": bool(it.get("isSiyez")), "alg": it.get("allergens") or [],
            "name": name, "desc": desc,
        })

    # ---- categories ------------------------------------------------------
    cat_items = {}
    for it in raw_items:
        cat_items.setdefault(it["cat"], []).append(it)
    for lst in cat_items.values():
        lst.sort(key=lambda x: (x["order"], x["n"]))
    cat_order = sorted(cat_items, key=lambda c: (GROUP_ORDER.index(GROUP_OF.get(c, "other")),
                                                 min(i["n"] for i in cat_items[c])))

    # ---- group size variants (e.g. Yeni Rakı 20/35/50/70/100 cl) ---------
    variant_cats = set(ov.get("variantCategories", []))
    items_out, cats_out = [], []
    for c in cat_order:
        lst = cat_items[c]
        cards = []
        if c in variant_cats:
            buckets = {}
            for it in lst:
                base, vol = split_volume(it["name"]["tr"])
                key = variant_key(it, base, vol)
                buckets.setdefault(key, []).append((it, vol))
            seen = set()
            for it in lst:
                base, vol = split_volume(it["name"]["tr"])
                key = variant_key(it, base, vol)
                if key in seen:
                    continue
                seen.add(key)
                group = buckets[key]
                if len(group) < 2:
                    cards.append(it)
                    continue
                group.sort(key=lambda g: int(g[1].split()[0]))
                head = dict(group[0][0])
                head["name"] = {l: split_volume(head["name"][l])[0] for l in LANGS}
                head["price"] = group[0][0]["price"]
                head["variants"] = [{"n": g[0]["n"], "label": g[1], "price": g[0]["price"]} for g in group]
                cards.append(head)
        else:
            cards = lst

        names = {l: c for l in LANGS}
        for l in LANGS:
            names[l] = pages[l][0]["categoryNames"].get(c, c)
        hours = base_props.get("serviceHours", {}).get(c)
        cat = {
            "id": slugify(c), "key": c, "group": GROUP_OF.get(c, "other"), "name": names,
            "count": len(lst), "cover": next((i["img"] for i in lst if i["img"]), None),
        }
        if hours:
            cat["hours"] = [hours["start"], hours["end"]]
        cats_out.append(cat)
        for it in cards:
            it = dict(it)
            it["cat"] = cat["id"]
            it.pop("order", None)
            items_out.append(it)

    # ---- photos ----------------------------------------------------------
    photos_dir = os.path.join(ROOT, "photos")
    os.makedirs(os.path.join(photos_dir, "s"), exist_ok=True)
    colors = {}
    for it in items_out:
        if it["img"] and it["img"] not in colors:
            colors[it["img"]] = ensure_photo(it["img"], photos_dir, sources[it["img"]])[0]
        if it["img"]:
            it["c"] = colors[it["img"]]
    for c in cats_out:
        if c["cover"] and c["cover"] not in colors:
            colors[c["cover"]] = ensure_photo(c["cover"], photos_dir, sources[c["cover"]])[0]

    for sub in ("", "s"):
        d = os.path.join(photos_dir, sub)
        for f in os.listdir(d):
            if f.endswith(".webp") and f[:-5] not in colors:
                os.remove(os.path.join(d, f))

    # compact output: drop empty fields
    for it in items_out:
        if not any(it["desc"].values()):
            del it["desc"]
        if not it["alg"]:
            del it["alg"]
        if not it["siyez"]:
            del it["siyez"]
        if not it["img"]:
            del it["img"]

    allergens = [{"key": a["name"], "name": {l: next((x["label"] for x in pages[l][0]["allergens"]
                                                      if x["name"] == a["name"]), a["label"]) for l in LANGS}}
                 for a in base_props["allergens"]]

    brand = {}
    for l in LANGS:
        msgs = pages[l][1]
        brand[l] = {f"{ns}.{k}": msgs[ns][k] for ns, keys in MESSAGE_KEYS.items()
                    for k in keys if k in msgs.get(ns, {})}

    known = {i["n"] for i in raw_items}
    featured = [f for f in ov.get("featured", []) if f["n"] in known]

    data = {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "langs": LANGS,
        "groups": [g for g in GROUP_ORDER if any(c["group"] == g for c in cats_out)],
        "cats": cats_out,
        "items": items_out,
        "allergens": allergens,
        "featured": featured,
        "allergenFilters": bool(ov.get("allergenFilters", False)),
        "brand": brand,
        "contact": ov.get("contact", {}),
    }
    out = os.path.join(ROOT, "data", "menu.js")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("/* Generated by tools/sync.py from mezzagurme.com — edit tools/overrides.json, not this file. */\n")
        f.write("window.MENU=")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    total = sum(c["count"] for c in cats_out)
    print(f"wrote {out}: {len(cats_out)} categories, {total} positions, {len(items_out)} cards, "
          f"{len(colors)} photos", file=sys.stderr)


if __name__ == "__main__":
    main()
