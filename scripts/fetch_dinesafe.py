#!/usr/bin/env python3
"""Download the City of Toronto DineSafe open dataset and build data/establishments.raw.json.

Then run:  node scripts/dedupe.js   (merges duplicates and writes data/establishments.json)

Data: City of Toronto Open Data, DineSafe. Contains information licensed under the
Open Government Licence - Toronto (https://open.toronto.ca/open-data-licence/).
Only each establishment's name, address, phone and location are kept; inspection results are discarded.
"""
import csv, io, json, os, re, sys, urllib.request

RESOURCE = "75dbb3ff-8281-4f03-9de2-bd1214761302"   # the 'Dinesafe' datastore resource
URL = f"https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/{RESOURCE}?format=csv"
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "data", "establishments.raw.json")

# Names that are clearly not restaurants (schools, child care, places of worship...). dedupe.js adds a few more.
NOT_FOOD = re.compile(r"\b(school|daycare|day care|child ?care|academy|nursery|hospital|college|university|church|learning|montessori|kindergarten|centre for|retirement|long term care|residence|seniors?|camp)\b", re.I)

print("Downloading DineSafe (about 45 MB)...", file=sys.stderr)
raw = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "toronto-restaurant-grader/1.0"}), timeout=180).read().decode("utf-8-sig")
seen, out = set(), []
for row in csv.DictReader(io.StringIO(raw)):
    if row["estId"] in seen:
        continue
    seen.add(row["estId"])
    addr = re.sub(r"\s+", " ", row["address"].replace(" None ", " ")).strip()
    num = lambda v: float(v) if v not in ("None", "") else None
    out.append({
        "id": row["estId"], "name": row["estName"].strip(), "address": addr,
        "phone": row["phone"] if row["phone"] not in ("None", "") else "",
        "lat": num(row["latitude"]), "lng": num(row["longitude"]),
        "likelyRestaurant": not NOT_FOOD.search(row["estName"]),
    })
out.sort(key=lambda e: e["name"].lower())
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(f"Wrote {len(out)} establishments to {OUT}")
