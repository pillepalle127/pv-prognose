#!/usr/bin/env python3
"""Prognosefehler nach vorhergesagter Klarheit (ICON-Vortagesstrahlung / wolkenlos nach Haurwitz).

Rechner: Entwicklungsrechner oder Desktop. Standort aus lokal.json (siehe README). Liest data/stunden/: ist_stunden.json (von stunden.py) und icon_d2_*.json
(Open-Meteo Previous Runs, timeformat=unixtime). Prognose wie das ICON-Skript: Stundenfaktoren aus den 7 letzten
gültigen Tagen, Lernfenster bis zum Vortag (entspricht dem Morgen-Snapshot).

  python3 klarheit.py      # Tabellen
  python3 klarheit.py -v   # dazu die Oktobertage einzeln
"""
import json, math, glob, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
ROOT = Path(__file__).resolve().parent
P = str(ROOT / 'data' / 'stunden') + '/'
TZ = ZoneInfo('Europe/Berlin'); H = 3600000
_lokal = json.load(open(ROOT / 'lokal.json', encoding='utf-8'))
LAT, LON = _lokal['lat'], _lokal['lon']
SOURCES = ["DC_MPPT_288_P", "DC_MPPT_291_P", "alias.0.VenusOS.DC_MPPT_292_P", "alias.0.VenusOS.DC_MPPT_293_P",
           "alias.0.VenusOS.DC_MPPT_294_P", "alias.0.VenusOS.DC_MPPT_296_P", "alias.0.GroWatt_WR.OutputPower", "PV_Garage_P"]

def cosz(ts):
    u = datetime.fromtimestamp(ts / 1000, timezone.utc)
    doy = u.timetuple().tm_yday; hr = u.hour + u.minute / 60
    g = 2 * math.pi / 365 * (doy - 1 + (hr - 12) / 24)
    eot = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    ha = math.radians((hr * 60 + eot + 4 * LON) / 4 - 180); la = math.radians(LAT)
    return math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)

def clearsky(ts0):
    """Haurwitz, Mittel über die Stunde ab ts0, kWh/m²"""
    s = 0
    for i in range(12):
        c = cosz(ts0 + (i + 0.5) * 300000)
        if c > 0: s += 1098 * c * math.exp(-0.057 / c)
    return s / 12 / 1000

rad = {}
for f in sorted(glob.glob(P + 'icon_d2_*.json')):
    h = json.load(open(f))['hourly']
    for i, t in enumerate(h['time']):
        rad[t * 1000 - H] = {k: (h[k][i] or 0) / 1000 for k in h if k != 'time'}

act = json.load(open(P + 'ist_stunden.json'))
days = []
for day in sorted(act):
    rec = act[day]
    d0 = datetime.strptime(day, '%Y%m%d').replace(tzinfo=TZ)
    t0 = int(d0.timestamp() * 1000); t1 = int((d0 + timedelta(days=1)).replace(hour=0).timestamp() * 1000)
    hours = []
    for i in range(25):
        ts = t0 + i * H
        if ts >= t1: break
        r = rad.get(ts)
        if r is None:
            if clearsky(ts) > 0: hours = None; break
            r = {'shortwave_radiation_previous_day1': 0, 'shortwave_radiation': 0, 'direct_radiation_previous_day1': 0}   # Nachtstunde fehlt am Abrufende
        hours.append(dict(ts=ts, h=datetime.fromtimestamp(ts / 1000, TZ).hour, act=sum(rec['src'][s][i] for s in SOURCES if s in rec['src']),
                          g1=r['shortwave_radiation_previous_day1'], g0=r['shortwave_radiation'], d1=r['direct_radiation_previous_day1'], cs=clearsky(ts)))
    if hours is None: continue
    # Lücke nur, wenn > 30 min ohne jeden Wert bei Tageslicht (wolkenlos > 100 W/m²); nachts schweigen die Quellen bei 0 W
    light = [x for x in hours if x['cs'] > 0.1]
    gap = any(sum(max(0, min(b, x['ts'] + H) - max(a, x['ts'])) for x in light) > 30 * 60000 for a, b in rec['gaps'])
    valid = len(rec['present']) == 8 and not gap
    days.append(dict(day=day, hours=hours, valid=valid, why='' if valid else ('Quelle fehlt' if len(rec['present']) < 8 else 'Lücke'),
                     A=sum(x['act'] for x in hours), G1=sum(x['g1'] for x in hours), G0=sum(x['g0'] for x in hours),
                     CS=sum(x['cs'] for x in hours), D1=sum(x['d1'] for x in hours)))
# Plausibilität wie im Skript: Ertrag je Ist-Strahlung < 25 % des Medians -> ungültig
rs = sorted(d['A'] / d['G0'] for d in days if d['valid'] and d['G0'] >= 0.5)
med = rs[len(rs) // 2]
for d in days:
    if d['valid'] and d['G0'] >= 0.5 and d['A'] / d['G0'] < 0.25 * med: d['valid'] = False; d['why'] = 'unplausibel'

def forecast(d, learn, key='g1'):
    sa = sum(x['act'] for L in learn for x in L['hours']); sr = sum(x[key] for L in learn for x in L['hours'])
    k = sa / sr
    kh = {}
    for h in range(24):
        a = sum(x['act'] for L in learn for x in L['hours'] if x['h'] == h); r = sum(x[key] for L in learn for x in L['hours'] if x['h'] == h)
        kh[h] = a / r if r > 0.05 else k
    return sum(kh[x['h']] * x['g1'] for x in d['hours']), k

valid = [d for d in days if d['valid']]
res = []
for i, d in enumerate(valid):
    if i < 7: continue
    f, k = forecast(d, valid[i - 7:i])
    f0, k0 = forecast(d, valid[i - 7:i], 'g0')
    res.append(dict(day=d['day'], f=f, f0=f0, a=d['A'], kt=d['G1'] / d['CS'], kt0=d['G0'] / d['CS'], k=k, need=d['A'] / d['G1'] if d['G1'] else 0))

print(f"Tage gesamt {len(days)}, gültig {len(valid)}, ausgewertet {len(res)} ({res[0]['day']}–{res[-1]['day']})")
print('ungültig:', ', '.join(f"{d['day'][6:]}.{d['day'][4:6]}. {d['why']}" for d in days if not d['valid']))
kts = sorted(r['kt'] for r in res)
print('vorhergesagte Klarheit (ICON Vortag / wolkenlos): Median %.2f, 90 %%: %.2f, max %.2f' % (kts[len(kts) // 2], kts[int(len(kts) * 0.9)], kts[-1]))

def line(name, R, fk='f'):
    if not R: print(f"{name:34s} –"); return
    e = [r[fk] - r['a'] for r in R]; A = sum(r['a'] for r in R)
    ct = sum(34 * x if x > 0 else -24 * x for x in e) / len(e)
    lo = sum(1 for x in e if x < 0)
    print(f"{name:34s} {len(R):3d} Tage  Ist Ø {A / len(R):5.1f}  Fehler Ø {sum(e) / len(e):+5.2f} kWh ({100 * sum(e) / A:+5.1f} %)  "
          f"MAE {sum(map(abs, e)) / len(e):4.2f}  zu niedrig {lo:3d}/{len(R)}  {ct:4.0f} ct/Tag")

print('\nPrognose wie das Skript (Stundenfaktoren aus 7 Tagen, gegen Vortagesstrahlung gelernt)')
B = [(0.9, 9), (0.8, 0.9), (0.6, 0.8), (0.4, 0.6), (0, 0.4)]
for lo, hi in B:
    line(f"ICON-Klarheit {lo:.1f}–{hi if hi < 9 else '':}", [r for r in res if lo <= r['kt'] < hi])
line('alle', res)
print('\nzum Vergleich: Faktoren gegen Strahlung des jüngsten Laufs gelernt, Prognose mit Vortagesstrahlung')
for lo, hi in B:
    line(f"ICON-Klarheit {lo:.1f}–{hi if hi < 9 else '':}", [r for r in res if lo <= r['kt'] < hi], 'f0')
line('alle', res, 'f0')
print('\nje Monat, Prognose wie das Skript: Fehler Ø in % (Anzahl Tage)')
print('Monat     Klarheit >= 0,9    0,8–0,9      0,6–0,8      < 0,6')
for m in sorted({r['day'][:6] for r in res}):
    cells = []
    for lo, hi in ((0.9, 9), (0.8, 0.9), (0.6, 0.8), (0, 0.6)):
        R = [r for r in res if r['day'][:6] == m and lo <= r['kt'] < hi]
        cells.append(f"{100 * sum(r['f'] - r['a'] for r in R) / sum(r['a'] for r in R):+5.1f} % ({len(R):2d})" if R else '      –     ')
    print(f"{m[4:]}/{m[:4]}   " + '   '.join(cells))
if '-v' in sys.argv:
    for r in [r for r in res if r['day'] >= '20261001']:
        print(f"  {r['day']} Klarheit {r['kt']:.2f} (Ist-Lauf {r['kt0']:.2f})  Ist {r['a']:5.1f}  Prog {r['f']:5.1f}  {100 * (r['f'] / r['a'] - 1):+4.0f} %  Faktor {r['k']:5.2f} nötig {r['need']:5.2f}")
