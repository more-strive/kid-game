import sys, os, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

OUT = os.path.join("public", "icons", "games")
os.makedirs(OUT, exist_ok=True)
BASE = "https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@master/color/svg/{}.svg"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
      "Cache-Control": "no-cache"}

pairs = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    slug, code = line.split()
    pairs.append((slug, code))


def fetch(item):
    slug, code = item
    dest = os.path.join(OUT, slug + ".svg")
    if os.path.exists(dest) and os.path.getsize(dest) > 200:
        return slug, "skip"
    last = ""
    for attempt in range(3):
        try:
            url = BASE.format(code) + f"?v={code}{attempt}"
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if data[:200].lstrip().startswith(b"<svg"):
                with open(dest, "wb") as f:
                    f.write(data)
                return slug, "ok"
            last = "not-svg"
        except Exception as e:
            last = f"{type(e).__name__}:{e}"
        time.sleep(0.8)
    return slug, "FAIL " + last


ok = fail = skip = 0
fails = []
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = [ex.submit(fetch, p) for p in pairs]
    for f in as_completed(futs):
        slug, res = f.result()
        if res == "ok":
            ok += 1
        elif res == "skip":
            skip += 1
        else:
            fail += 1
            fails.append((slug, res))

print(f"ok={ok} skip={skip} fail={fail} total={len(pairs)}")
for s, r in fails[:30]:
    print(" ", s, r)
