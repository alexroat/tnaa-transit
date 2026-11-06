#!/usr/bin/env python3
"""Scarica i GTFS da BusOne e produce app/data/net.json, compatto e pronto per il browser.

Fonti: Trentino Trasporti (bus + Trento-Male) e Trenitalia (solo corse che toccano il Trentino).
Uso: python3 -I scripts/build_data.py [--no-download]
"""
import csv, io, json, math, os, sys, time, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
OUT = os.path.join(ROOT, "app", "data", "net.json")
FEEDS = [
    ("tt", "https://proxy.busone.app/trentino/gtfs.zip"),
    ("trn", "https://proxy.busone.app/trenitalia/gtfs.zip"),
]
# Rettangolo sulle linee ferroviarie trentine: esclude di proposito Bolzano, Verona, Bassano e Feltre.
RAIL_AREA = (45.68, 10.85, 46.27, 11.66)  # lat min, lon min, lat max, lon max
SIMPLIFY_M = 8.0
HEADERS = {"User-Agent": "tnttmonitor-poc", "X-BusOne-Client": "tnttmonitor-poc", "X-BusOne-Use": "personal"}


def download(name, url):
    path = os.path.join(CACHE, f"{name}.zip")
    if "--no-download" not in sys.argv or not os.path.exists(path):
        print("scarico", url)
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=180) as r, open(path, "wb") as f:
            f.write(r.read())
    return path


def rows(z, name):
    if name not in z.namelist():
        return
    yield from csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig"))


def hms(s):
    if not s:
        return None
    h, m, x = s.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(x)


def xy(lon, lat, lat0):
    return lon * 111320 * math.cos(math.radians(lat0)), lat * 110540


def simplify(pts):
    """Douglas-Peucker iterativo; pts e una lista di (lon, lat)."""
    if len(pts) < 3:
        return pts
    lat0 = pts[0][1]
    p = [xy(a, b, lat0) for a, b in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = p[a]
        dx, dy = p[b][0] - ax, p[b][1] - ay
        den = dx * dx + dy * dy
        best, at = -1.0, -1
        for i in range(a + 1, b):
            ex, ey = p[i][0] - ax, p[i][1] - ay
            t = max(0.0, min(1.0, (ex * dx + ey * dy) / den)) if den else 0.0
            d = (ex - t * dx) ** 2 + (ey - t * dy) ** 2
            if d > best:
                best, at = d, i
        if best > SIMPLIFY_M ** 2:
            keep[at] = True
            stack += [(a, at), (at, b)]
    return [q for q, k in zip(pts, keep) if k]


def project(line, cum, lon, lat, start):
    """Distanza lungo la linea della fermata, solo in avanti da `start`.

    Prende il primo minimo locale vicino alla linea: sulle linee ad anello evita di agganciare il passaggio sbagliato.
    Ritorna (distanza, indice di segmento).
    """
    lat0 = line[0][1]
    px, py = xy(lon, lat, lat0)
    best, best_d, best_seg = 1e18, 0.0, start
    for i in range(start, len(line) - 1):
        ax, ay = xy(*line[i], lat0)
        bx, by = xy(*line[i + 1], lat0)
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den)) if den else 0.0
        d = math.hypot(px - ax - t * dx, py - ay - t * dy)
        if d < best:
            best, best_seg = d, i
            best_d = cum[i] + t * (cum[i + 1] - cum[i])
        elif best < 120 and d > best + 400:
            break
    return best_d, best_seg


def lengths(line):
    out, lat0 = [0.0], line[0][1]
    for a, b in zip(line, line[1:]):
        ax, ay = xy(*a, lat0)
        bx, by = xy(*b, lat0)
        out.append(out[-1] + math.hypot(bx - ax, by - ay))
    return out


def fill_times(times):
    """Riempie gli orari vuoti (fermate non cronometrate) per interpolazione."""
    known = [i for i, t in enumerate(times) if t is not None]
    for a, b in zip(known, known[1:]):
        for i in range(a + 1, b):
            times[i] = times[a] + (times[b] - times[a]) * (i - a) // (b - a)
    for i in range(known[0]):
        times[i] = times[known[0]]
    for i in range(known[-1] + 1, len(times)):
        times[i] = times[known[-1]]
    return times


net = {"stops": [], "routes": [], "services": [], "shapes": [], "patterns": [], "offsets": [], "trips": []}
stop_ix, route_ix, svc_ix, shape_ix, pat_ix, off_ix = {}, {}, {}, {}, {}, {}


def load_feed(name, path):
    z = zipfile.ZipFile(path)
    raw_stops = {s["stop_id"]: s for s in rows(z, "stops.txt")}

    def station(sid):
        s = raw_stops[sid]
        parent = s.get("parent_station")
        return raw_stops[parent] if parent and parent in raw_stops else s

    routes = {r["route_id"]: r for r in rows(z, "routes.txt")}
    trips = {t["trip_id"]: t for t in rows(z, "trips.txt")}

    by_trip = {}
    for r in rows(z, "stop_times.txt"):
        if r["trip_id"] in trips:
            by_trip.setdefault(r["trip_id"], []).append(
                (int(r["stop_sequence"]), r["stop_id"], hms(r["arrival_time"]), hms(r["departure_time"]))
            )

    if name == "trn":
        la0, lo0, la1, lo1 = RAIL_AREA
        def inside(sid):
            s = raw_stops[sid]
            return s["stop_lat"] and la0 < float(s["stop_lat"]) < la1 and lo0 < float(s["stop_lon"]) < lo1
        by_trip = {t: v for t, v in by_trip.items() if any(inside(x[1]) for x in v)}

    wanted_shapes = {trips[t].get("shape_id") for t in by_trip}
    shapes = {}
    for r in rows(z, "shapes.txt"):
        if r["shape_id"] in wanted_shapes:
            shapes.setdefault(r["shape_id"], []).append(
                (int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"]))
            )

    used_services = set()
    for tid, st in by_trip.items():
        t = trips[tid]
        st.sort()
        if len(st) < 2:
            continue
        r = routes[t["route_id"]]
        rail = r["route_type"] in ("0", "1", "2", "5", "6", "7") or 100 <= int(r["route_type"]) < 200
        rkey = (name, t["route_id"])
        if rkey not in route_ix:
            route_ix[rkey] = len(net["routes"])
            net["routes"].append([
                t["route_id"], (r.get("route_short_name") or "").strip(), (r.get("route_long_name") or "").strip(),
                (r.get("route_color") or "").strip(), 1 if rail else 0, name,
            ])
        idx = []
        for _, sid, _, _ in st:
            s = station(sid)
            key = (name, s["stop_id"])
            if key not in stop_ix:
                stop_ix[key] = len(net["stops"])
                net["stops"].append([s["stop_id"], s["stop_name"].strip(), round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5), 0])
            if rail:
                net["stops"][stop_ix[key]][4] = 1
            idx.append(stop_ix[key])

        sid_shape = t.get("shape_id") or ""
        if sid_shape in shapes:
            skey = (name, sid_shape)
            if skey not in shape_ix:
                line = [(a, b) for _, a, b in sorted(shapes[sid_shape])]
                shape_ix[skey] = len(net["shapes"])
                net["shapes"].append(simplify(line))
        else:  # corsa senza shape: linea diretta fra le fermate
            skey = (name, "stops", tuple(idx))
            if skey not in shape_ix:
                shape_ix[skey] = len(net["shapes"])
                net["shapes"].append([(net["stops"][i][3], net["stops"][i][2]) for i in idx])
        sh = shape_ix[skey]

        seqs = tuple(x[0] for x in st)
        pkey = (sh, tuple(idx), seqs)
        if pkey not in pat_ix:
            line = net["shapes"][sh]
            cum = lengths(line)
            dist, seg = [], 0
            for i in idx:
                d, seg = project(line, cum, net["stops"][i][3], net["stops"][i][2], seg)
                dist.append(round(d))
            pat_ix[pkey] = len(net["patterns"])
            net["patterns"].append([sh, idx, dist, list(seqs)])

        arr = fill_times([x[2] if x[2] is not None else x[3] for x in st])
        dep = fill_times([x[3] if x[3] is not None else x[2] for x in st])
        start = dep[0]
        flat = tuple(v for a, d in zip(arr, dep) for v in (a - start, d - start))
        if flat not in off_ix:
            off_ix[flat] = len(net["offsets"])
            net["offsets"].append(list(flat))

        used_services.add(t["service_id"])
        skey2 = (name, t["service_id"])
        if skey2 not in svc_ix:
            svc_ix[skey2] = len(net["services"])
            net["services"].append([0, "0", "0", [], []])
        net["trips"].append([
            tid, route_ix[rkey], svc_ix[skey2], (t.get("trip_headsign") or "").strip(), pat_ix[pkey], start,
            off_ix[flat], (t.get("trip_short_name") or "").strip(),
        ])

    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for c in rows(z, "calendar.txt"):
        k = (name, c["service_id"])
        if k in svc_ix:
            s = net["services"][svc_ix[k]]
            s[0] = sum(1 << i for i, d in enumerate(days) if c[d] == "1")
            s[1], s[2] = c["start_date"], c["end_date"]
    for c in rows(z, "calendar_dates.txt"):
        k = (name, c["service_id"])
        if k in svc_ix:
            net["services"][svc_ix[k]][3 if c["exception_type"] == "1" else 4].append(c["date"])


t0 = time.time()
os.makedirs(CACHE, exist_ok=True)
for feed, url in FEEDS:
    load_feed(feed, download(feed, url))
net["shapes"] = [[round(c, 5) for p in s for c in p] for s in net["shapes"]]
net["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
with open(OUT, "w") as f:
    json.dump(net, f, ensure_ascii=False, separators=(",", ":"))
print({k: len(v) for k, v in net.items() if isinstance(v, list)})
print(f"{os.path.getsize(OUT) / 1e6:.2f} MB in {time.time() - t0:.0f}s")
