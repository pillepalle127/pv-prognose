#!/usr/bin/env python3
"""History-Tage von der Kodi-Box holen (nur lesen, gleicher Schlüssel und Befehl wie fetch.sh) und gleich auf
Stundenwerte je Quelle verdichten -> data/stunden/ist_stunden.json. Ein Sommertag hat bis 18 MB, deshalb nicht in data/raw.
Rechner: Entwicklungsrechner. Schon vorhandene Tage werden übersprungen.

  python3 stunden.py 2026-10-28 2026-11-15
"""
import json, subprocess, sys, os
from datetime import date, timedelta
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import auswertung as A
OUT = ROOT / 'data' / 'stunden' / 'ist_stunden.json'
OUT.parent.mkdir(parents=True, exist_ok=True)
res = json.load(open(OUT)) if os.path.exists(OUT) else {}
d0, d1 = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])
local = A.HIST
d = d0
while d <= d1:
    day = d.strftime('%Y%m%d')
    if day in res: d += timedelta(days=1); continue
    p = local / f'{day}.txt'
    if p.exists() and day >= '20261022':
        txt = p.read_text(encoding='utf-8')
    else:
        r = subprocess.run(['ssh', '-i', os.path.expanduser('~/.ssh/kodibox_pvexport'), '-o', 'IdentitiesOnly=yes',
                            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '-T',
                            'kodibox@192.168.1.4', f'hist {day}'], capture_output=True, timeout=120)
        txt = r.stdout.decode('utf-8')
        if '### end' not in txt:
            print(day, 'Export unvollständig', file=sys.stderr); d += timedelta(days=1); continue
    tmp = OUT.parent / 'tmp_tag.txt'
    open(tmp, 'w', encoding='utf-8').write(txt)
    ex = A.read_export(tmp)
    os.remove(tmp)
    t0, t1 = A.day_bounds(day)
    rec = {'present': [s for s in A.SOURCES if s in ex], 'src': {}, 'ts': {}}
    for s in A.SOURCES:
        pts = [q for q in ex.get(s, []) if q[0] >= t0 - 12 * 3600000]
        st, gap = A.energy_steps(pts, t1)
        rec['src'][s] = [round(A.produced([st], t0 + h * 3600000, min(t0 + (h + 1) * 3600000, t1)), 4) for h in range(25)]
        rec['ts'][s] = [q[0] for q in pts if t0 <= q[0] < t1]   # für die Lückenprüfung
    # Lücke: längster Abstand ohne irgendeinen Wert, je Stunde
    allts = sorted({t for v in rec['ts'].values() for t in v} | {t0, t1})
    rec['gaps'] = [[a, b] for a, b in zip(allts, allts[1:]) if b - a > 30 * 60000]
    del rec['ts']
    res[day] = rec
    json.dump(res, open(OUT, 'w'))
    print(day, len(rec['present']), 'Quellen', round(sum(sum(v) for v in rec['src'].values()), 2), 'kWh', len(rec['gaps']), 'Lücken', flush=True)
    d += timedelta(days=1)
