#!/usr/bin/env python3
"""Auswertung der Live-Werte von ICON und VRM gegen das gemessene Ist.

Rechner: Entwicklungsrechner oder Desktop. Liest data/raw/hist/JJJJMMTT.txt (von ./fetch.sh hist).
Stichprobe: jede volle Stunde + 20 min (nach den Abrufen ICON :10 und VRM :15). Jede Prognose
gilt mit ihrem letzten Wert, null (Neustart in ioBroker) gilt als "kein Wert".

  Rest heute: Prognose zur Uhrzeit t gegen das, was ab t bis Tagesende erzeugt wurde
  morgen:     Prognose zur Uhrzeit t gegen den Ertrag des Folgetags

Varianten: ICON, VRM, Minimum aus beiden. Verglichen werden nur Zeitpunkte, an denen beide einen
Wert haben. Gewichtung: jede kWh zu viel 34 ct, zu wenig 24 ct.
"""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Berlin")
HIST = Path(__file__).parent / "data" / "raw" / "hist"
SOURCES = [
    "DC_MPPT_288_P", "DC_MPPT_291_P",
    "alias.0.VenusOS.DC_MPPT_292_P", "alias.0.VenusOS.DC_MPPT_293_P",
    "alias.0.VenusOS.DC_MPPT_294_P", "alias.0.VenusOS.DC_MPPT_296_P",
    "alias.0.GroWatt_WR.OutputPower", "PV_Garage_P",
]
LIVE = "0_userdata.0.pvForecast{}.forecast.{}"
OVER_CT, UNDER_CT = 34, 24
MAX_HOLD_MIN = 30      # länger hält eine Quelle mit Leistung > 10 W ihren Wert nicht, sonst Lücke
ZERO_W = 10
MIN_REST_KWH = 0.5     # Rest heute nur auswerten, solange noch etwas zu erwarten ist


def read_export(path):
    sec, cur, buf = {}, None, []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("### "):
            if cur:
                sec[cur] = "\n".join(buf)
            cur, buf = line[4:], []
        else:
            buf.append(line)
    out = {}
    for name, body in sec.items():
        if name.startswith("hist "):
            out[name[5:]] = sorted(((r["ts"], r.get("val")) for r in json.loads(body)), key=lambda x: x[0])
    return out


def day_bounds(day):
    d0 = datetime.strptime(day, "%Y%m%d").replace(tzinfo=TZ)
    d1 = (d0 + timedelta(days=1)).replace(hour=0)
    return int(d0.timestamp() * 1000), int(d1.timestamp() * 1000)


def energy_steps(points, t_end):
    """[(ts_von, ts_bis, W)] als Stufenfunktion; null und zu lange Haltezeiten werden zu Lücken."""
    steps, gap_ms = [], 0
    for (ta, va), (tb, _) in zip(points, points[1:] + [(t_end, None)]):
        if not isinstance(va, (int, float)):
            continue
        tb = min(tb, t_end)
        if va > ZERO_W and tb - ta > MAX_HOLD_MIN * 60000:
            gap_ms += tb - ta - MAX_HOLD_MIN * 60000
            tb = ta + MAX_HOLD_MIN * 60000
        if tb > ta:
            steps.append((ta, tb, max(va, 0)))
    return steps, gap_ms


def produced(steps_all, t0, t1):
    wh = 0.0
    for steps in steps_all:
        for a, b, w in steps:
            lo, hi = max(a, t0), min(b, t1)
            if hi > lo:
                wh += w * (hi - lo) / 3600000
    return wh / 1000


def value_at(points, t):
    v = None
    for ts, val in points:
        if ts > t:
            break
        v = val if isinstance(val, (int, float)) else None
    return v


def stats(pairs):
    if not pairs:
        return None
    e = [f - a for f, a in pairs]
    over = sum(x for x in e if x > 0)
    under = -sum(x for x in e if x < 0)
    return {
        "n": len(e),
        "bias": sum(e) / len(e),
        "mae": sum(abs(x) for x in e) / len(e),
        "over": over / len(e),
        "under": under / len(e),
        "ct": (over * OVER_CT + under * UNDER_CT) / len(e),
        "max_over": max([x for x in e if x > 0], default=0.0),
    }


def main():
    files = sorted(HIST.glob("[0-9]" * 8 + ".txt"))
    days = {p.stem: read_export(p) for p in files}
    actual = {}
    for day, d in days.items():
        t0, t1 = day_bounds(day)
        steps_all, gaps = [], 0
        for s in SOURCES:
            st, g = energy_steps([p for p in d.get(s, []) if p[0] >= t0 - 12 * 3600000], t1)
            steps_all.append(st)
            gaps += g
        actual[day] = (steps_all, produced(steps_all, t0, t1), gaps / 60000)
        print(f"Ist {day}: {actual[day][1]:.2f} kWh, Lücken zusammen {actual[day][2]:.0f} min")

    pairs = {(q, v): [] for q in ("rest", "morgen") for v in ("ICON", "VRM", "Minimum")}
    rows = []
    for day, d in days.items():
        t0, t1 = day_bounds(day)
        nxt = (datetime.strptime(day, "%Y%m%d") + timedelta(days=1)).strftime("%Y%m%d")
        steps_all = actual[day][0]
        h = 0
        while True:
            t = int((datetime.fromtimestamp(t0 / 1000, TZ) + timedelta(hours=h, minutes=20)).timestamp() * 1000)
            h += 1
            if t >= t1:
                break
            rest_true = produced(steps_all, t, t1)
            row = {"day": day, "t": t, "rest_true": rest_true}
            for q, key in (("rest", "pv_remaining_today_kWh"), ("morgen", "pv_tomorrow_kWh")):
                fi = value_at(d.get(LIVE.format("Icon", key), []), t)
                fv = value_at(d.get(LIVE.format("Vrm", key), []), t)
                row[q] = (fi, fv)
                true = rest_true if q == "rest" else (actual[nxt][1] if nxt in actual else None)
                if fi is None or fv is None or true is None:
                    continue
                if q == "rest" and max(true, fi, fv) < MIN_REST_KWH:
                    continue
                pairs[(q, "ICON")].append((fi, true))
                pairs[(q, "VRM")].append((fv, true))
                pairs[(q, "Minimum")].append((min(fi, fv), true))
            rows.append(row)

    if "-v" in sys.argv:
        for r in rows:
            ts = datetime.fromtimestamp(r["t"] / 1000, TZ).strftime("%d.%m. %H:%M")
            fmt = lambda x: "  –  " if x is None else f"{x:5.2f}"
            print(f"{ts}  Rest heute: ICON {fmt(r['rest'][0])} VRM {fmt(r['rest'][1])} Ist {r['rest_true']:5.2f}"
                  f"  |  morgen: ICON {fmt(r['morgen'][0])} VRM {fmt(r['morgen'][1])}")

    print()
    print("Variante        Anzahl  mittl. Fehler  mittl. abs. Fehler  zu viel  zu wenig  max. zu viel  gewichtet")
    for q, title in (("rest", "Rest heute"), ("morgen", "morgen")):
        print(title)
        for v in ("ICON", "VRM", "Minimum"):
            s = stats(pairs[(q, v)])
            if not s:
                print(f"  {v:<12}  keine Werte")
                continue
            print(f"  {v:<12}  {s['n']:6d}  {s['bias']:+10.2f} kWh  {s['mae']:13.2f} kWh  {s['over']:5.2f}  {s['under']:7.2f}"
                  f"  {s['max_over']:9.2f} kWh  {s['ct']:6.0f} ct")


if __name__ == "__main__":
    main()
