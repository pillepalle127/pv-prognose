#!/usr/bin/env python3
"""AC-Verbrauch laut Venus (alias.0.VenusOS.AC_Consumption_P) je Tag und Stunde -> data/stunden/verbrauch_stunden.json.
Abruf wie fetch.sh (nur lesen). Rechner: Entwicklungsrechner. Vorhandene Tage werden übersprungen.

  python3 verbrauch.py 2026-10-30 2026-11-20
"""
import json, subprocess, sys, os
from datetime import date, timedelta
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import auswertung as A
ID = 'alias.0.VenusOS.AC_Consumption_P'
OUT = ROOT / 'data' / 'stunden' / 'verbrauch_stunden.json'
TMP = ROOT / 'data' / 'stunden' / 'tmp_verbrauch.txt'
OUT.parent.mkdir(parents=True, exist_ok=True)
res = json.load(open(OUT)) if os.path.exists(OUT) else {}
d, d1 = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])
while d <= d1:
    day = d.strftime('%Y%m%d'); d += timedelta(days=1)
    if day in res: continue
    r = subprocess.run(['ssh', '-i', os.path.expanduser('~/.ssh/kodibox_pvexport'), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
                        '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '-T', 'kodibox@192.168.1.4', f'hist {day}'], capture_output=True, timeout=120)
    txt = r.stdout.decode('utf-8')
    if '### end' not in txt: print(day, 'Export unvollständig', flush=True); continue
    open(TMP, 'w', encoding='utf-8').write(txt)
    ex = A.read_export(Path(TMP)); os.remove(TMP)
    if ID not in ex: print(day, 'kein Verbrauch in der History', flush=True); continue
    t0, t1 = A.day_bounds(day)
    pts = [q for q in ex[ID] if q[0] >= t0 - 12 * 3600000]
    st, gap = A.energy_steps(pts, t1)
    hours = [round(A.produced([st], t0 + h * 3600000, min(t0 + (h + 1) * 3600000, t1)), 4) for h in range(25)]
    inday = [q for q in pts if t0 <= q[0] < t1]
    res[day] = {'kWh': round(sum(hours), 3), 'hours': hours, 'gap_min': round(gap / 60000), 'n': len(inday),
                'nulls': sum(1 for q in inday if not isinstance(q[1], (int, float)))}
    json.dump(res, open(OUT, 'w'))
    print(day, res[day]['kWh'], 'kWh', res[day]['n'], 'Werte', res[day]['gap_min'], 'min Lücke', flush=True)
