#!/usr/bin/env python3
"""ICON-Strahlung und PV-Ertrag gegen die gemessene Globalstrahlung einer DWD-Station.

Rechner: Entwicklungsrechner oder Desktop.
Holt die 10-Minuten-Werte der Station aus lokal.json ("dwd_station", DWD Open Data, recent: etwa 500 Tage
bis gestern), summiert sie je Stunde (Ortszeit) nach data/stunden/dwd_stunden.json und liest die Lerntage
des ICON-Skripts aus dem neuesten Export data/raw/JJJJ-MM-TT_HHMM.txt (./fetch.sh).

  python3 strahlung.py                          Tage ab 2026-10-10, Zerlegung ab 2026-10-23
  python3 strahlung.py 2026-10-31 2026-11-12    Zerlegung nur für diese Tage

Zerlegung der Day-Ahead-Prognose (Faktoren wie im Skript: 7 letzte gültige Lerntage, je Stunde
Ist / ICON-Vortagesstrahlung):
  Fehler = Prognose(ICON-Vortag) − Ist
         = [Prognose(ICON-Vortag) − Prognose(gemessen)]  Strahlung
         + [Prognose(gemessen) − Ist]                    Umrechnung
"""
import io
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Berlin")
ROOT = Path(__file__).parent
STATION = json.loads((ROOT / "lokal.json").read_text(encoding="utf-8"))["dwd_station"]
URL = ("https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/"
       f"10_minutes/solar/recent/10minutenwerte_SOLAR_{STATION}_akt.zip")
OUT = ROOT / "data" / "stunden" / "dwd_stunden.json"
LEARN_DAYS = 7
SHOW_FROM = "2026-10-10"


def fetch_station():
    with urllib.request.urlopen(URL, timeout=60) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))
    name = next(n for n in z.namelist() if n.startswith("produkt_"))
    hours = {}
    for line in z.read(name).decode("latin-1").splitlines()[1:]:
        p = [s.strip() for s in line.split(";")]
        gs = float(p[4])                      # GS_10: Globalstrahlung J/cm² je 10 min, -999 = fehlt
        if gs < 0:
            continue
        t = datetime.strptime(p[1], "%Y%m%d%H%M").replace(tzinfo=timezone.utc).astimezone(TZ)
        day = hours.setdefault(t.strftime("%Y-%m-%d"), [[0.0, 0] for _ in range(24)])
        day[t.hour][0] += gs * 1e4 / 3.6e6     # J/cm² -> kWh/m²
        day[t.hour][1] += 1
    # nur Stunden mit allen Werten (sechs, bei der Umstellung auf Winterzeit die doppelte Stunde 2 mit zwölf)
    out = {d: [round(v, 4) if n in (6, 12) else None for v, n in hs] for d, hs in hours.items()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    return out


def learn_days():
    files = sorted((ROOT / "data" / "raw").glob("????-??-??_????.txt"))
    sec, cur = {}, None
    for line in files[-1].read_text(encoding="utf-8").splitlines():
        if line.startswith("### "):
            cur = line[4:]
            continue
        sec[cur] = sec.get(cur, "") + line
    v = json.loads(sec["state 0_userdata.0.pvForecastIcon.learn.days_json"])
    days = json.loads(v["val"]) if isinstance(v, dict) else v
    return files[-1].name, days


def factors(window):
    sa = sum(sum(x["act"]) for x in window)
    sr = sum(sum(x["ghi"]) for x in window)
    k = sa / sr if sr > 0 else 0
    kh = []
    for h in range(24):
        a = sum(x["act"][h] for x in window)
        r = sum(x["ghi"][h] for x in window)
        kh.append(a / r if r > 0.05 else k)
    return kh, k


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    d_from = args[0] if args else "2026-10-23"
    d_to = args[1] if len(args) > 1 else "9999-12-31"
    meas = fetch_station()
    src, days = learn_days()
    print(f"Lerntage aus {src}, Messung bis {max(meas)}")
    print()
    print("Tag         Ist    gemessen  ICON-Vortag  ICON-jüngst  Vortag/gem  jüngst/gem  Ist/gem")
    for x in days:
        d = x["date"]
        gm = meas.get(d)
        if d < SHOW_FROM or not gm or None in gm:
            continue
        a, g, gd, g0 = sum(x["act"]), sum(gm), sum(x["ghi"]), sum(x["ghi0"])
        print(f"{d}  {a:5.2f}  {g:6.3f}    {gd:6.3f}      {g0:6.3f}      {gd/g:5.2f}      {g0/g:5.2f}    {a/g:5.2f}"
              f"  {'' if x['valid'] else 'ungültig: ' + x.get('why', '')}")

    print()
    print("Tag         Faktor  Ist    Prognose   Prognose     Fehler   davon      davon")
    print("            Ø Fenster      ICON-Vortag gemessen            Strahlung  Umrechnung")
    rows = []
    for i, x in enumerate(days):
        d = x["date"]
        gm = meas.get(d)
        if not (d_from <= d <= d_to) or not gm or None in gm:
            continue
        win = [y for y in days[:i] if y["valid"]][-LEARN_DAYS:]
        if len(win) < LEARN_DAYS:
            continue
        kh, k = factors(win)
        a = sum(x["act"])
        fd = sum(kh[h] * x["ghi"][h] for h in range(24))
        fm = sum(kh[h] * gm[h] for h in range(24))
        rows.append((fd - a, fd - fm, fm - a))
        print(f"{d}  {k:6.2f}  {a:6.2f}  {fd:6.2f}     {fm:6.2f}     {fd-a:+6.2f}   {fd-fm:+6.2f}     {fm-a:+6.2f}")
    if rows:
        n = len(rows)
        print(f"Ø {n} Tage: Fehler {sum(r[0] for r in rows)/n:+.2f} = Strahlung {sum(r[1] for r in rows)/n:+.2f}"
              f" + Umrechnung {sum(r[2] for r in rows)/n:+.2f} kWh;"
              f" abs. Ø Strahlung {sum(abs(r[1]) for r in rows)/n:.2f}, Umrechnung {sum(abs(r[2]) for r in rows)/n:.2f} kWh")


if __name__ == "__main__":
    main()
