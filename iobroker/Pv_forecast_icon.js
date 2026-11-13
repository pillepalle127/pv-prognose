/*
 * PV-Prognose aus DWD ICON-D2 (über Open-Meteo), gleiche Methode wie im Backtest pv_backtest.py
 *
 * Prognose:   Globalstrahlung (Stundenmittel) aus ICON-D2, je Tagesstunde mit einem eigenen Faktor in kWh umgerechnet
 * Faktoren:   gelernt aus den letzten LEARN_DAYS gültigen Tagen: Ist-Ertrag je Stunde (ioBroker-History, 6 MPPT + Growatt + HMS)
 *             gesamt und je Quelle (Prognose und Vergleich auch je Quelle)
 *             gegen die ICON-Strahlung, die 24 h vorher vorhergesagt war (Open-Meteo Previous Runs API)
 * Start:      fehlen Lerntage, werden sie sofort aus History und Prognosearchiv nachgeholt (kein Warten)
 * Gültigkeit: Tag ungültig bei Logging-Ausfall (keine Quelle loggt > MAX_GAP_MIN bei Tageslicht)
 *             oder wenn der Ertrag < PLAUS_MIN des Üblichen bei der tatsächlichen Strahlung liegt (eingefrorene Werte);
 *             tatsächliche Strahlung = jüngster ICON-Lauf (wie im Backtest), nicht die Day-Ahead-Prognose
 *
 * Abläufe:  FETCH_CRON  Prognose heute/morgen aktualisieren (Snapshot nach Neustart bis CATCHUP_H Stunden nachgeholt)
 *           META_CRON   Lauf-Stand bei Open-Meteo prüfen; ist ein neuer ICON-D2-Lauf abrufbar, Prognose sofort holen
 *           22:00       Snapshot Day-Ahead für morgen;  06:00 Snapshot Morgen für heute
 *           00:40       gestern: Lerntag anhängen; ICON- und VRM-Snapshots (Day-Ahead, Morgen) stündlich gegen dasselbe Ist
 *                       vergleichen. Snapshots werden je Datum archiviert (snap.archive_json), VRM-Snapshots aus dem VRM-Skript
 * Backtest:  backtest.run = true (oder BT_CRON) rechnet die Prognose rückwirkend ab BT_START mit genau diesem Code nach:
 *            Fehler gesamt, je Monat, schlechteste Tage, Lernfenster-Vergleich, je Quelle -> Log und backtest.result_json
 * Datenpunkte unter 0_userdata.0.pvForecastIcon.*, History für Zahlenwerte wird beim Anlegen aktiviert.
 * Dauerskript, als eigenes Skript speichern. Ausgabe auf Loglevel "warn".
 *
 * Änderungen 2026-10-24:
 *    - Plausibilitätsprüfung der Lerntage gegen die tatsächliche Strahlung (ghi0) statt gegen die Day-Ahead-Prognose
 *      (vorher wurden Tage mit stark zu hoher Prognose als "unplausibel" verworfen -> Faktoren zu hoch).
 *      Lerntage ohne ghi0 werden beim ersten Start einmalig neu berechnet.
 *    - Tagesabschluss: bei Fehler einmalige Wiederholung nach 30 min
 *
 * Änderungen 2026-10-25:
 *    - Neuer Lauf wird sofort geholt: META_CRON prüft alle 5 min meta.json bei Open-Meteo und ruft die Prognose ab,
 *      sobald ein neuer Lauf abrufbar ist (vorher bis zu 60 min Verzug bis zum Abruf um :10)
 *    - Lauf-Stand je Abruf in forecast.run_init_ts, run_available_ts, run_modified_ts (ms seit 1970, mit History)
 *    - Snapshot-Archiv 30 statt 10 Tage
 *    - Abruf läuft nie doppelt gleichzeitig (Abruf, Snapshot und Lauf-Prüfung können zusammenfallen)
 *
 * Änderungen 2026-10-27:
 *    - Open-Meteo-Zeiten als Unix-Zeit (timeformat=unixtime). Mit timezone=Europe/Berlin rechnet Open-Meteo die ganze
 *      Antwort mit dem Versatz zum Abrufzeitpunkt um; über eine Zeitumstellung hinweg lag eine Seite 1 h daneben
 *      (betraf vor allem den Backtest, z. B. am 01.11. alle Sommertage)
 */

// ======================= Konfiguration =======================
const LAT = null, LON = null;   // eigenen Standort eintragen (Grad, WGS84)
const MODEL         = 'icon_d2';
const BASE          = '0_userdata.0.pvForecastIcon.';
const VRM_BASE      = '0_userdata.0.pvForecastVrm.';
const HIST          = 'history.0';
const SOURCES       = [   // History-Schlüssel wie in pv_backtest.py, Leistung in W
    { name: 'MPPT 288',   id: 'DC_MPPT_288_P' },
    { name: 'MPPT 291',   id: 'DC_MPPT_291_P' },
    { name: 'MPPT 292',   id: 'alias.0.VenusOS.DC_MPPT_292_P' },
    { name: 'MPPT 293',   id: 'alias.0.VenusOS.DC_MPPT_293_P' },
    { name: 'MPPT 294',   id: 'alias.0.VenusOS.DC_MPPT_294_P' },
    { name: 'MPPT 296',   id: 'alias.0.VenusOS.DC_MPPT_296_P' },
    { name: 'Growatt',    id: 'alias.0.GroWatt_WR.OutputPower' },   // AC
    { name: 'HMS Garage', id: 'PV_Garage_P' },                      // AC; Growatt + HMS = PvOnGrid
];
const LEARN_DAYS    = 7;      // aus dem Fenstervergleich im Backtest (7 Tage: kleinster Tagesfehler)
const LEARN_MIN     = 5;
const MAX_GAP_MIN   = 30;
const ZERO_W        = 10;     // Growatt meldet nachts gehaltene ~7 W
const PLAUS_MIN     = 0.25;
const FETCH_CRON    = '10 * * * *';
const META_CRON     = '*/5 * * * *';   // Lauf-Stand prüfen; neuer Lauf -> sofort abrufen
const META_URL      = 'https://api.open-meteo.com/data/dwd_icon_d2/static/meta.json';
const SNAP_DA_CRON  = '0 22 * * *';
const SNAP_MO_CRON  = '0 6 * * *';
const FINALIZE_CRON = '40 0 * * *';
const KEEP_DAYS     = 60;     // Lerntage im Speicher
const KEEP_COMPARE  = 400;
const BT_START      = '2026-06-20';   // Backtest ab hier (alle sechs MPPT in der History)
const BT_SWEEP      = [3, 5, 7, 10, 14, 21, 28];
const BT_SWEEP_HIST = 14;     // Fenstervergleich nur über Tage mit mind. so vielen gültigen Vortagen
const BT_CRON       = '30 3 1 * *';   // automatischer Backtest am 1. des Monats 03:30 ('' = nur auf Knopfdruck)
const CATCHUP_H     = 2;      // verpasster Snapshot (Neustart) wird bis zu so viele Stunden nach dem Termin nachgeholt
// =============================================================

const https = require('https');
const H = 3600000;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dayStart(off) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d; }
function dayOf(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function nextDay(d) { const x = new Date(d); x.setDate(x.getDate() + 1); return x; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HIST_CFG = { enabled: true, changesOnly: true, debounceTime: 0, retention: 31536000 };
const DEFS = [
    ['forecast.pv_today_kWh',            'PV-Prognose heute gesamt',                    'number', 'kWh', null, true],
    ['forecast.pv_remaining_today_kWh',  'PV-Prognose Rest heute',                      'number', 'kWh', null, true],
    ['forecast.pv_next1h_kWh',           'PV-Prognose nächste volle Stunde',            'number', 'kWh', null, true],
    ['forecast.pv_next3h_kWh',           'PV-Prognose nächste 3 volle Stunden',         'number', 'kWh', null, true],
    ['forecast.pv_tomorrow_kWh',         'PV-Prognose morgen gesamt',                   'number', 'kWh', null, true],
    ['forecast.pv_hourly_json',          'PV-Prognose stündlich [Stundenbeginn ts_ms, kWh]', 'string', '', '[]', false],
    ['forecast.ghi_hourly_json',         'Strahlung stündlich [Stundenbeginn ts_ms, kWh/m²]', 'string', '', '[]', false],
    ['forecast.src_json',                'PV-Prognose je Quelle {Quelle: {today, tomorrow}} kWh', 'string', '', '{}', false],
    ['forecast.lastUpdate',              'Letzter erfolgreicher Abruf (ISO)',           'string', '',    '',   false],
    ['forecast.error',                   'Fehler (leer = OK)',                          'string', '',    '',   false],
    ['forecast.run_init_ts',             'ICON-Lauf des letzten Abrufs: Start (ms)',    'number', 'ms',  null, true],
    ['forecast.run_available_ts',        'ICON-Lauf des letzten Abrufs: abrufbar seit (ms)', 'number', 'ms', null, true],
    ['forecast.run_modified_ts',         'ICON-Lauf des letzten Abrufs: zuletzt geändert (ms)', 'number', 'ms', null, true],
    ['learn.days_json',                  'Lerntage [{date, valid, why, act[24], ghi[24], ghi0[24], src}]', 'string', '', '[]', false],
    ['learn.factors_json',               'Faktoren je Stunde (kWh je kWh/m²)',          'string', '',    '{}', false],
    ['learn.days_used',                  'Gültige Lerntage im Fenster',                 'number', '',    0,    false],
    ['snap.dayahead_date',               'Day-Ahead: Zieldatum',                        'string', '',    '',   false],
    ['snap.dayahead_kWh',                'Day-Ahead: Prognose (Vortag 22 Uhr)',         'number', 'kWh', null, true],
    ['snap.dayahead_hourly_json',        'Day-Ahead: Stundenwerte [Stunde, kWh]',       'string', '',    '[]', false],
    ['snap.morning_date',                'Morgen: Datum',                               'string', '',    '',   false],
    ['snap.morning_kWh',                 'Morgen: Prognose (6 Uhr)',                    'number', 'kWh', null, true],
    ['snap.morning_hourly_json',         'Morgen: Stundenwerte [Stunde, kWh]',          'string', '',    '[]', false],
    ['snap.archive_json',                'Snapshot-Archiv {Datum: {dayahead, morning}} (letzte Tage)', 'string', '', '{}', false],
    ['backtest.run',                     'Backtest starten (auf true setzen)',          'boolean', '',   false, false],
    ['backtest.running',                 'Backtest läuft',                              'boolean', '',   false, false],
    ['backtest.lastRun',                 'Letzter Backtest (ISO)',                      'string', '',    '',   false],
    ['backtest.result_json',             'Backtest-Ergebnis (JSON)',                    'string', '',    '{}', false],
    ['backtest.dayahead_nmae_day_pct',   'Backtest: Tagesfehler Day-Ahead (nMAE)',      'number', '%',   null, true],
    ['backtest.dayahead_nmae_hour_pct',  'Backtest: Stundenfehler Day-Ahead (nMAE)',    'number', '%',   null, true],
    ['backtest.dayahead_bias_day_kWh',   'Backtest: Bias Day-Ahead je Tag',             'number', 'kWh', null, true],
    ['compare.days_json',                'Vergleich je Tag, ICON und VRM gegen dasselbe Ist [{date, act, icon_da, icon_mo, vrm_da, vrm_mo, dev_*_pct, mae_*_h}]', 'string', '', '[]', false],
    ['compare.lastDay_date',             'Letzter ausgewerteter Tag',                   'string', '',    '',   false],
    ['compare.lastDay_actual_kWh',       'Letzter Tag: Ist',                            'number', 'kWh', null, true],
    ['compare.lastDay_dayahead_kWh',     'Letzter Tag: Day-Ahead',                      'number', 'kWh', null, true],
    ['compare.lastDay_dev_dayahead_pct', 'Letzter Tag: Abweichung Day-Ahead (+ = zu hoch)', 'number', '%', null, true],
    ['compare.lastDay_dev_morning_pct',  'Letzter Tag: Abweichung Morgen (+ = zu hoch)',    'number', '%', null, true],
    ['compare.lastDay_mae_dayahead_kWh', 'Letzter Tag: mittl. Stundenabweichung Day-Ahead', 'number', 'kWh', null, true],
    ['compare.lastDay_vrm_dev_dayahead_pct', 'Letzter Tag: VRM Day-Ahead Abweichung (gleiches Ist)', 'number', '%', null, true],
    ['compare.lastDay_vrm_mae_dayahead_kWh', 'Letzter Tag: VRM Day-Ahead mittl. Stundenabweichung (gleiches Ist)', 'number', 'kWh', null, true],
];

// eigener Speicher, damit gerade geschriebene Werte sofort lesbar sind
const mem = {};
function setV(p, v) { mem[p] = v; setState(BASE + p, v, true); }
function getV(p) { if (p in mem) return mem[p]; const s = getState(BASE + p); return (s && s.val !== undefined) ? s.val : null; }
function getVrm(p) { const s = getState(VRM_BASE + p); return (s && s.val !== undefined) ? s.val : null; }
const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

async function initStates() {
    for (const [p, name, type, unit, def, hist] of DEFS) {
        if (existsObject(BASE + p)) continue;
        const common = { name, type, unit, role: type === 'number' ? 'value' : (type === 'boolean' ? 'switch' : 'text'), read: true, write: p === 'backtest.run' };
        if (hist && HIST) common.custom = { [HIST]: HIST_CFG };
        await createStateAsync(BASE + p, def, common);
    }
}

// ---------- Open-Meteo ----------
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 60000 }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let js;
                try { js = JSON.parse(body); } catch (e) { return reject(new Error(`HTTP ${res.statusCode}, keine JSON-Antwort`)); }
                if (res.statusCode !== 200 || js.error) return reject(new Error(`Open-Meteo HTTP ${res.statusCode}: ${js.reason || body.slice(0, 200)}`));
                resolve(js);
            });
        });
        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.on('error', reject);
    });
}

// Stand des neuesten ICON-D2-Laufs bei Open-Meteo, Zeiten in ms
async function fetchMeta() {
    const js = await getJson(META_URL);
    if (!js.last_run_initialisation_time || !js.last_run_availability_time) throw new Error('meta.json ohne Laufzeiten');
    return { init: js.last_run_initialisation_time * 1000, avail: js.last_run_availability_time * 1000,
        mod: js.last_run_modification_time ? js.last_run_modification_time * 1000 : null };
}

// -> Map Stundenbeginn ts -> kWh/m² (Wert gilt für die Stunde vor dem Zeitstempel)
function toHourMap(js, variable) {
    const hr = js.hourly || {};
    if (!Array.isArray(hr[variable])) throw new Error(`Open-Meteo liefert ${variable} nicht (vorhanden: ${Object.keys(hr).join(', ')})`);
    const m = new Map();
    hr.time.forEach((t, i) => {
        const v = hr[variable][i];
        if (v === null || v === undefined) return;
        m.set(t * 1000 - H, v / 1000);   // Unix-Zeit in s (timeformat=unixtime); W/m² über 1 h -> kWh/m²
    });
    return m;
}

async function fetchLive() {
    const q = `latitude=${LAT}&longitude=${LON}&hourly=shortwave_radiation&models=${MODEL}&timezone=Europe%2FBerlin&timeformat=unixtime&forecast_days=3`;
    return toHourMap(await getJson('https://api.open-meteo.com/v1/forecast?' + q), 'shortwave_radiation');
}

// Archiv in Blöcken bis 30 Tage: {day1: Map, day0: Map} (day1 = Lauf ca. 1 Tag vorher, day0 = jüngster Lauf ≈ tatsächliche Strahlung)
async function fetchArchiveRange(d0, d1) {
    const day1 = new Map(), day0 = new Map();
    for (let a = dayOf(d0); a <= dayOf(d1); ) {
        let b = new Date(a); b.setDate(b.getDate() + 29); if (b > dayOf(d1)) b = dayOf(d1);
        const q = `latitude=${LAT}&longitude=${LON}&hourly=shortwave_radiation_previous_day1,shortwave_radiation&models=${MODEL}&timezone=Europe%2FBerlin&timeformat=unixtime&start_date=${dateStr(a)}&end_date=${dateStr(b)}`;
        const js = await getJson('https://previous-runs-api.open-meteo.com/v1/forecast?' + q);
        for (const [k, v] of toHourMap(js, 'shortwave_radiation_previous_day1')) day1.set(k, v);
        for (const [k, v] of toHourMap(js, 'shortwave_radiation')) day0.set(k, v);
        a = nextDay(b);
    }
    return { day1, day0 };
}

// ---------- Ist-Ertrag eines Tages aus der History ----------
function hist(id, start, end) {
    return new Promise((resolve, reject) => {
        getHistory(HIST, { id, start, end, aggregate: 'none', ignoreNull: true, count: 2000000 }, (err, res) => {
            if (err) return reject(new Error(`getHistory ${id}: ${err}`));
            resolve((Array.isArray(res) ? res : [])
                .filter(p => p && p.val !== null && p.val !== undefined && isFinite(Number(p.val)))
                .map(p => ({ ts: p.ts, val: Number(p.val) }))
                .sort((a, b) => a.ts - b.ts));
        });
    });
}

// -> {act: [24] kWh gesamt, src: {Quelle: [24] kWh}, outageDaylight: bool, nPts}
async function actualDay(d, ghiMap) {
    const ds = d.getTime(), de = nextDay(d).getTime();
    const series = [];
    let nPts = 0;
    for (const src of SOURCES) {
        const pts = await hist(src.id, ds - 12 * H, de);
        nPts += pts.filter(p => p.ts >= ds).length;
        series.push(pts);
    }
    // Ausfälle: Lücken, in denen keine Quelle geloggt hat
    const union = [...new Set([ds, de, ...series.flatMap(s => s.filter(p => p.ts >= ds && p.ts < de).map(p => p.ts))])].sort((a, b) => a - b);
    const outages = [];
    for (let i = 1; i < union.length; i++) if (union[i] - union[i - 1] > MAX_GAP_MIN * 60000) outages.push([union[i - 1], union[i]]);

    const act = new Array(24).fill(0), cov = new Array(24).fill(0);
    const srcAct = SOURCES.map(() => new Array(24).fill(0));
    const hourIdx = ts => new Date(ts).getHours();
    const add = (si, a, b, p) => {
        let segs = [[a, b]];
        if (Math.abs(p) > ZERO_W) {
            for (const [oa, ob] of outages) {
                const nx = [];
                for (const [sa, sb] of segs) {
                    if (ob <= sa || oa >= sb) { nx.push([sa, sb]); continue; }
                    if (sa < oa) nx.push([sa, oa]);
                    if (ob < sb) nx.push([ob, sb]);
                }
                segs = nx;
            }
        }
        for (let [sa, sb] of segs) {
            while (sa < sb) {
                const e = Math.min(sb, sa - (sa % H) + H);
                const h = hourIdx(sa);
                act[h] += Math.max(p, 0) * (e - sa) / H / 1000;
                srcAct[si][h] += Math.max(p, 0) * (e - sa) / H / 1000;
                cov[h] += (e - sa) / H / SOURCES.length;
                sa = e;
            }
        }
    };
    series.forEach((pts, si) => {
        let cur = null, last = ds;
        for (const p of pts) {
            if (p.ts <= ds) { cur = p.val; continue; }
            if (p.ts >= de) break;
            if (cur !== null) add(si, last, p.ts, cur);
            cur = p.val; last = p.ts;
        }
        if (cur !== null) add(si, last, de, cur);
    });
    // Tageslicht-Stunden = Stunden mit prognostizierter Strahlung
    let outageDaylight = false;
    for (let h = 0; h < 24; h++) {
        const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
        if ((ghiMap.get(ts) || 0) > 0 && cov[h] < 0.9) outageDaylight = true;
    }
    const src = {};
    SOURCES.forEach((s, i) => { src[s.name] = srcAct[i].map(r3); });
    return { act: act.map(r3), src, outageDaylight, nPts };
}

function ghiArray(d, ghiMap) {
    const out = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) out[h] = r3(ghiMap.get(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime()) || 0);
    return out;
}

// ---------- Lernen ----------
function learnDays() { return parse(getV('learn.days_json') || '[]', []); }

function hourFactors(days, actOf) {
    const sa = days.reduce((s, x) => s + actOf(x).reduce((a, b) => a + b, 0), 0);
    const sr = days.reduce((s, x) => s + x.ghi.reduce((a, b) => a + b, 0), 0);
    const k = sr > 0 ? sa / sr : 0;
    const kh = [];
    for (let h = 0; h < 24; h++) {
        const a = days.reduce((s, x) => s + actOf(x)[h], 0), r = days.reduce((s, x) => s + x.ghi[h], 0);
        kh.push(r > 0.05 ? a / r : k);
    }
    return kh;
}

let lastKhS = null;   // Faktoren je Quelle aus dem letzten Abruf

function factors() {
    const days = learnDays().filter(x => x.valid).slice(-LEARN_DAYS);
    if (days.length < LEARN_MIN) return { kh: null, n: days.length, khS: null };
    const sdays = days.filter(x => x.src);
    let khS = null;
    if (sdays.length >= LEARN_MIN) {
        khS = {};
        for (const s of SOURCES) khS[s.name] = hourFactors(sdays, x => x.src[s.name] || new Array(24).fill(0));
    }
    const kh = hourFactors(days, x => x.act);
    return { kh, n: days.length, khS };
}

function addLearnDay(rec) {
    let days = learnDays().filter(x => x.date !== rec.date);
    // Plausibilität gegen die bisherigen gültigen Tage, Bezug: tatsächliche Strahlung (ghi0), wie im Backtest
    const ratio = x => {
        if (!Array.isArray(x.ghi0)) return null;
        const g = x.ghi0.reduce((a, b) => a + b, 0);
        return g >= 0.5 ? x.act.reduce((a, b) => a + b, 0) / g : null;
    };
    const rs = days.filter(x => x.valid).map(ratio).filter(v => v !== null).sort((a, b) => a - b);
    const r = ratio(rec);
    if (rec.valid && r !== null && rs.length >= 5 && r < PLAUS_MIN * rs[Math.floor(rs.length / 2)]) {
        rec.valid = false; rec.why = 'Ertrag unplausibel niedrig (Datenausfall?)';
    }
    days.push(rec);
    days.sort((a, b) => a.date < b.date ? -1 : 1);
    setV('learn.days_json', JSON.stringify(days.slice(-KEEP_DAYS)));
}

// arc = {day1, day0} aus fetchArchiveRange
async function learnFor(d, arc) {
    const a = await actualDay(d, arc.day1);
    const rec = { date: dateStr(d), valid: true, why: '', act: a.act, ghi: ghiArray(d, arc.day1), ghi0: ghiArray(d, arc.day0), src: a.src };
    if (!a.nPts) { rec.valid = false; rec.why = 'keine History-Werte'; }
    else if (a.outageDaylight) { rec.valid = false; rec.why = 'Logging-Ausfall bei Tageslicht'; }
    addLearnDay(rec);
    return rec;
}

async function bootstrap() {
    const complete = x => x.src && Array.isArray(x.ghi0);   // Tage ohne Werte je Quelle oder ohne ghi0 neu berechnen
    const have = new Set(learnDays().filter(complete).map(x => x.date));
    const valid = learnDays().filter(x => x.valid && complete(x)).length;
    if (valid >= LEARN_DAYS) return;
    const need = LEARN_DAYS + 7;
    const d0 = dayStart(-need), d1 = dayStart(-1);
    const arc = await fetchArchiveRange(dateStr(d0), dateStr(d1));
    let added = 0;
    for (let d = d0; d <= d1; d = nextDay(d)) {
        if (have.has(dateStr(d))) continue;
        const rec = await learnFor(d, arc);
        added++;
        if (!rec.valid) log(`PV-ICON: Lerntag ${rec.date} ungültig: ${rec.why}`, 'warn');
    }
    log(`PV-ICON: ${added} Lerntage nachgeholt, gültig im Fenster: ${factors().n}`, 'warn');
}

// ---------- Prognose ----------
let ghiLive = new Map();
let fcRunning = null;      // laufender Abruf; wer währenddessen aufruft, wartet auf denselben
let lastRunAvail = null;   // run_available_ts des letzten erfolgreichen Abrufs

function updateForecast() {
    if (!fcRunning) fcRunning = updateForecastNow().finally(() => { fcRunning = null; });
    return fcRunning;
}

async function updateForecastNow() {
    try {
        let meta = null;
        try { meta = await fetchMeta(); } catch (e) { /* Lauf-Stand unbekannt, Prognose trotzdem holen */ }
        ghiLive = await fetchLive();
        const { kh, n, khS } = factors();
        lastKhS = khS;
        setV('learn.days_used', n);
        setV('learn.factors_json', JSON.stringify(kh ? kh.map(r3) : null));
        const t0 = dayStart(0).getTime(), t1 = dayStart(1).getTime(), t2 = dayStart(2).getTime();
        const hNow = new Date(); hNow.setMinutes(0, 0, 0);
        const th = hNow.getTime(), now = Date.now();
        const pv = new Map();
        for (const [ts, g] of ghiLive) if (kh) pv.set(ts, kh[new Date(ts).getHours()] * g);
        const sum = (a, b) => { let s = 0; for (const [ts, v] of pv) if (ts >= a && ts < b) s += v; return s; };
        let rest = 0;
        for (const [ts, v] of pv) {
            if (ts < t0 || ts >= t1) continue;
            if (ts >= th + H) rest += v; else if (ts === th) rest += v * (1 - (now - th) / H);
        }
        const tomorrowComplete = [...ghiLive.keys()].some(ts => ts >= t2 - 3 * H && ts < t2);
        setV('forecast.ghi_hourly_json', JSON.stringify([...ghiLive].filter(([ts]) => ts >= t0 && ts < t2).map(([ts, g]) => [ts, r3(g)])));
        setV('forecast.pv_hourly_json', JSON.stringify([...pv].filter(([ts]) => ts >= t0 && ts < t2).map(([ts, v]) => [ts, r3(v)])));
        setV('forecast.pv_today_kWh', kh ? r2(sum(t0, t1)) : null);
        setV('forecast.pv_remaining_today_kWh', kh ? r2(rest) : null);
        setV('forecast.pv_next1h_kWh', kh ? r2(sum(th + H, th + 2 * H)) : null);
        setV('forecast.pv_next3h_kWh', kh ? r2(sum(th + H, th + 4 * H)) : null);
        setV('forecast.pv_tomorrow_kWh', kh && tomorrowComplete ? r2(sum(t1, t2)) : null);
        const srcOut = {};
        if (khS) {
            for (const s of SOURCES) {
                let td = 0, tm = 0;
                for (const [ts, g] of ghiLive) {
                    const v = khS[s.name][new Date(ts).getHours()] * g;
                    if (ts >= t0 && ts < t1) td += v; else if (ts >= t1 && ts < t2) tm += v;
                }
                srcOut[s.name] = { today: r2(td), tomorrow: tomorrowComplete ? r2(tm) : null };
            }
        }
        setV('forecast.src_json', JSON.stringify(srcOut));
        setV('forecast.run_init_ts', meta ? meta.init : null);
        setV('forecast.run_available_ts', meta ? meta.avail : null);
        setV('forecast.run_modified_ts', meta ? meta.mod : null);
        if (meta) lastRunAvail = meta.avail;
        setV('forecast.error', kh ? '' : `zu wenige gültige Lerntage (${n}/${LEARN_MIN})`);
        setV('forecast.lastUpdate', new Date().toISOString());
        return !!kh;
    } catch (e) {
        setV('forecast.error', e.message);
        log('PV-ICON: ' + e.message, 'warn');
        return false;
    }
}

// alle META_CRON: ist ein neuer Lauf abrufbar, gleich holen statt bis zum nächsten FETCH_CRON zu warten
async function checkRun() {
    try {
        const m = await fetchMeta();
        if (lastRunAvail === null) lastRunAvail = getV('forecast.run_available_ts');
        if (m.avail !== lastRunAvail) await updateForecast();
    } catch (e) { /* nächster Versuch beim nächsten Termin */ }
}

// Snapshots je Zieldatum aufbewahren (der Day-Ahead für einen Tag wird um 22:00 desselben Tages überschrieben)
const ARCHIVE_DAYS = 30;
function archiveGet() { return parse(getV('snap.archive_json') || '{}', {}) || {}; }
function archivePut(date, which, kWh, hourly, src) {
    const a = archiveGet();
    a[date] = a[date] || {};
    a[date][which] = { kWh, hourly, src: src || null, ts: new Date().toISOString() };
    for (const k of Object.keys(a).sort().slice(0, -ARCHIVE_DAYS)) delete a[k];
    setV('snap.archive_json', JSON.stringify(a));
}

async function snapshot(which, retry) {
    const off = which === 'dayahead' ? 1 : 0;
    const d = dayStart(off), t0 = d.getTime(), t1 = nextDay(d).getTime();
    const ok = await updateForecast();
    const pv = parse(getV('forecast.pv_hourly_json') || '[]', []).filter(([ts]) => ts >= t0 && ts < t1);
    const covered = pv.some(([ts]) => ts >= t0 + 10 * H && ts < t0 + 14 * H);
    if (!ok || !covered) {
        log(`PV-ICON: Snapshot ${which} ${retry ? 'wird in 5 min wiederholt' : 'fehlgeschlagen'}`, 'warn');
        if (retry) { setTimeout(() => snapshot(which, false), 5 * 60000); return; }
        setV(`snap.${which}_date`, dateStr(d)); setV(`snap.${which}_kWh`, null); setV(`snap.${which}_hourly_json`, '[]');
        return;
    }
    const hourly = pv.map(([ts, v]) => [new Date(ts).getHours(), r3(v)]);
    const kWh = r2(pv.reduce((s, [, v]) => s + v, 0));
    setV(`snap.${which}_date`, dateStr(d));
    setV(`snap.${which}_kWh`, kWh);
    setV(`snap.${which}_hourly_json`, JSON.stringify(hourly));
    let src = null;   // Stundenwerte je Quelle {Quelle: [[Stunde, kWh]]}
    if (lastKhS) {
        src = {};
        for (const s of SOURCES) {
            src[s.name] = [...ghiLive].filter(([ts]) => ts >= t0 && ts < t1)
                .map(([ts, g]) => [new Date(ts).getHours(), r3(lastKhS[s.name][new Date(ts).getHours()] * g)]);
        }
    }
    archivePut(dateStr(d), which, kWh, hourly, src);
}

async function finalizeYesterday(retry) {
    const d = dayStart(-1), date = dateStr(d);
    try {
        const arc = await fetchArchiveRange(date, date);
        const rec = await learnFor(d, arc);
        const act = rec.act.reduce((a, b) => a + b, 0);
        // Stundenprognosen als Map Stunde -> kWh
        const own = archiveGet()[date] || {};
        const ownH = w => {
            if (own[w] && own[w].hourly && own[w].hourly.length) return new Map(own[w].hourly);
            if (getV(`snap.${w}_date`) === date) { const h = parse(getV(`snap.${w}_hourly_json`) || '[]', []); if (h.length) return new Map(h); }
            return null;
        };
        const vrmArc = (parse(getVrm('snap.archive_json') || '{}', {}) || {})[date] || {};
        const vrmH = w => {
            let rows = vrmArc[w] && vrmArc[w].hourly && vrmArc[w].hourly.length ? vrmArc[w].hourly : null;
            if (!rows && getVrm(`snap.${w}_date`) === date) rows = parse(getVrm(`snap.${w}_hourly_json`) || '[]', []);
            if (!rows || !rows.length) return null;
            const m = new Map();
            for (const [ts, v] of rows) { const h = new Date(Number(ts)).getHours(); m.set(h, (m.get(h) || 0) + Number(v)); }   // VRM: [ts_ms, kWh]
            return m;
        };
        const evalFc = m => {
            if (!m) return { sum: null, dev: null, mae: null };
            let sum = 0, s = 0, n = 0;
            for (const v of m.values()) sum += v;
            for (let h = 0; h < 24; h++) { const f = m.get(h) || 0; if (rec.act[h] > 0 || f > 0) { s += Math.abs(f - rec.act[h]); n++; } }
            const ok = rec.valid && act >= 0.5;
            return { sum: r2(sum), dev: ok ? Math.round((sum - act) / act * 1000) / 10 : null, mae: ok && n ? r3(s / n) : null };
        };
        const iDa = evalFc(ownH('dayahead')), iMo = evalFc(ownH('morning'));
        const vDa = evalFc(vrmH('dayahead')), vMo = evalFc(vrmH('morning'));
        const entry = { date, valid: rec.valid, why: rec.why, act: r2(act),
            icon_da: iDa.sum, icon_mo: iMo.sum, vrm_da: vDa.sum, vrm_mo: vMo.sum,
            dev_icon_da_pct: iDa.dev, dev_icon_mo_pct: iMo.dev, dev_vrm_da_pct: vDa.dev, dev_vrm_mo_pct: vMo.dev,
            mae_icon_da_h: iDa.mae, mae_icon_mo_h: iMo.mae, mae_vrm_da_h: vDa.mae, mae_vrm_mo_h: vMo.mae };
        // je Quelle (nur ICON; VRM hat keine Aufteilung)
        entry.src = {};
        const srcLog = [];
        for (const s of SOURCES) {
            const sAct = (rec.src && rec.src[s.name]) || new Array(24).fill(0);
            const sActSum = sAct.reduce((a, b) => a + b, 0);
            const evalS = w => {
                const rows = own[w] && own[w].src && own[w].src[s.name];
                if (!rows || !rows.length) return { sum: null, dev: null, mae: null };
                const m = new Map(rows);
                let sum = 0, e = 0, n = 0;
                for (const v of m.values()) sum += v;
                for (let h = 0; h < 24; h++) { const f = m.get(h) || 0; if (sAct[h] > 0 || f > 0) { e += Math.abs(f - sAct[h]); n++; } }
                const ok = rec.valid && sActSum >= 0.2;
                return { sum: r2(sum), dev: ok ? Math.round((sum - sActSum) / sActSum * 1000) / 10 : null, mae: ok && n ? r3(e / n) : null };
            };
            const sDa = evalS('dayahead'), sMo = evalS('morning');
            entry.src[s.name] = { act: r2(sActSum), da: sDa.sum, dev_da_pct: sDa.dev, mae_da_h: sDa.mae, mo: sMo.sum, dev_mo_pct: sMo.dev, mae_mo_h: sMo.mae };
            srcLog.push(`${s.name} ${r2(sActSum)}/${sDa.sum ?? '–'} (${sDa.dev ?? '–'} %)`);
        }
        let cmp = parse(getV('compare.days_json') || '[]', []).filter(x => x.date !== date);
        cmp.push(entry);
        cmp.sort((a, b) => a.date < b.date ? -1 : 1);
        setV('compare.days_json', JSON.stringify(cmp.slice(-KEEP_COMPARE)));
        setV('compare.lastDay_date', date);
        setV('compare.lastDay_actual_kWh', entry.act);
        setV('compare.lastDay_dayahead_kWh', iDa.sum);
        setV('compare.lastDay_dev_dayahead_pct', iDa.dev);
        setV('compare.lastDay_dev_morning_pct', iMo.dev);
        setV('compare.lastDay_mae_dayahead_kWh', iDa.mae);
        setV('compare.lastDay_vrm_dev_dayahead_pct', vDa.dev);
        setV('compare.lastDay_vrm_mae_dayahead_kWh', vDa.mae);
        const f = x => x.sum === null ? '–' : `${x.sum} kWh (${x.dev ?? '–'} %, Std-MAE ${x.mae ?? '–'})`;
        log(`PV-ICON ${date}: Ist ${entry.act} kWh${rec.valid ? '' : ' (ungültig: ' + rec.why + ')'}`
            + ` | Day-Ahead ICON ${f(iDa)} / VRM ${f(vDa)} | Morgen ICON ${f(iMo)} / VRM ${f(vMo)}`, 'warn');
        log(`PV-ICON ${date} je Quelle Ist/Day-Ahead kWh: ${srcLog.join(' | ')}`, 'warn');
    } catch (e) {
        log(`PV-ICON: Tagesabschluss fehlgeschlagen${retry ? ', Wiederholung in 30 min' : ''}: ${e.message}`, 'warn');
        if (retry) setTimeout(() => finalizeYesterday(false), 30 * 60000);
    }
    await updateForecast();
}


// ======================= Backtest (gleicher Code wie die Live-Prognose) =======================
function btStats(pairs) {
    const n = pairs.length;
    if (!n) return null;
    let ae = 0, se = 0, b = 0, act = 0;
    for (const [f, a] of pairs) { const e = f - a; ae += Math.abs(e); se += e * e; b += e; act += a; }
    return { n, mae: ae / n, rmse: Math.sqrt(se / n), bias: b / n, act, nmae: act > 0 ? 100 * ae / act : null };
}

// Stundenfaktoren aus Lerntagen; actOf(x) -> [24], ghiOf(x) -> [24]
function btFactors(learn, actOf, ghiOf, perHour) {
    let sa = 0, sr = 0;
    for (const x of learn) for (let h = 0; h < 24; h++) { sa += actOf(x)[h]; sr += ghiOf(x)[h]; }
    const k = sr > 0 ? sa / sr : 0;
    const kh = [];
    for (let h = 0; h < 24; h++) {
        if (!perHour) { kh.push(k); continue; }
        let a = 0, r = 0;
        for (const x of learn) { a += actOf(x)[h]; r += ghiOf(x)[h]; }
        kh.push(r > 0.05 ? a / r : k);
    }
    return kh;
}

// Prognose eines Tages -> [[Prognose, Ist] je relevanter Stunde]
function btDay(day, learn, actOf, ghiKey, perHour) {
    const kh = btFactors(learn, actOf, x => x[ghiKey], perHour);
    const out = [];
    for (let h = 0; h < 24; h++) {
        const f = kh[h] * day[ghiKey][h], a = actOf(day)[h];
        if (a > 0 || day[ghiKey][h] > 0) out.push([f, a]);
    }
    return out;
}

function btEval(days, valid, evalDays, window, actOf, ghiKey, perHour) {
    const dayPairs = [], hourPairs = [], perDay = [];
    for (const d of evalDays) {
        const i = valid.indexOf(d);
        const learn = valid.slice(Math.max(0, i - window), i);
        if (learn.length < Math.min(LEARN_MIN, window)) continue;
        const ho = btDay(d, learn, actOf, ghiKey, perHour);
        const f = ho.reduce((s, [x]) => s + x, 0), a = ho.reduce((s, [, y]) => s + y, 0);
        hourPairs.push(...ho); dayPairs.push([f, a]); perDay.push({ date: d.date, f, a });
    }
    return { day: btStats(dayPairs), hour: btStats(hourPairs), perDay };
}

let btBusy = false;
async function runBacktest(reason) {
    if (btBusy) { log('PV-ICON Backtest: läuft bereits', 'warn'); return; }
    btBusy = true;
    setV('backtest.running', true);
    const t0 = Date.now();
    try {
        const d0 = BT_START, d1 = dateStr(dayStart(-1));
        log(`PV-ICON Backtest (${reason}): ${d0} bis ${d1}, Abruf Prognosearchiv …`, 'warn');
        const arc = await fetchArchiveRange(d0, d1);
        const days = [];
        for (let d = dayOf(d0); d <= dayOf(d1); d = nextDay(d)) {
            const a = await actualDay(d, arc.day1);
            const rec = { date: dateStr(d), act: a.act, src: a.src, g1: ghiArray(d, arc.day1), g0: ghiArray(d, arc.day0),
                valid: a.nPts > 0 && !a.outageDaylight, why: !a.nPts ? 'keine History-Werte' : (a.outageDaylight ? 'Logging-Ausfall' : '') };
            days.push(rec);
            await sleep(20);   // Adapter zwischendurch freigeben
        }
        // Plausibilität: Ertrag im Verhältnis zur tatsächlichen Strahlung (day0)
        const ratio = x => { const g = x.g0.reduce((s, v) => s + v, 0); return g >= 0.5 ? x.act.reduce((s, v) => s + v, 0) / g : null; };
        const rs = days.filter(x => x.valid).map(ratio).filter(v => v !== null).sort((a, b) => a - b);
        const med = rs.length ? rs[Math.floor(rs.length / 2)] : 0;
        const implaus = [];
        for (const x of days) { const r = ratio(x); if (x.valid && r !== null && r < PLAUS_MIN * med) { x.valid = false; x.why = 'Ertrag unplausibel'; implaus.push(`${x.date} (${r2(x.act.reduce((s, v) => s + v, 0))} kWh)`); } }
        const valid = days.filter(x => x.valid);
        const total = x => x.act;
        const evalAll = valid.slice(LEARN_MIN);
        const evalSweep = valid.slice(BT_SWEEP_HIST);

        const res = { start: d0, end: d1, days: days.length, valid: valid.length,
            invalid: days.filter(x => !x.valid).map(x => `${x.date}: ${x.why}`), learn_days: LEARN_DAYS, variants: {}, months: [], worst: [], sweep: [], sources: [] };
        const variants = [['dayahead_hour', 'g1', true], ['dayahead_day', 'g1', false], ['actualghi_hour', 'g0', true], ['actualghi_day', 'g0', false]];
        let main = null;
        for (const [name, key, ph] of variants) {
            const e = btEval(days, valid, evalAll, LEARN_DAYS, total, key, ph);
            res.variants[name] = { days: e.day ? e.day.n : 0, mae_day: e.day && r2(e.day.mae), nmae_day: e.day && r2(e.day.nmae), bias_day: e.day && r2(e.day.bias),
                mae_hour: e.hour && r3(e.hour.mae), rmse_hour: e.hour && r3(e.hour.rmse), nmae_hour: e.hour && r2(e.hour.nmae), bias_hour: e.hour && r3(e.hour.bias) };
            if (name === 'dayahead_hour') main = e;
        }
        const bym = {};
        for (const p of main.perDay) (bym[p.date.slice(0, 7)] = bym[p.date.slice(0, 7)] || []).push(p);
        for (const [m, l] of Object.entries(bym)) res.months.push({ month: m, days: l.length, act: r2(l.reduce((s, p) => s + p.a, 0)), fc: r2(l.reduce((s, p) => s + p.f, 0)),
            mae_day: r2(l.reduce((s, p) => s + Math.abs(p.f - p.a), 0) / l.length), over30: l.filter(p => p.a >= 0.5 && Math.abs(p.f - p.a) / p.a > 0.3).length });
        res.worst = [...main.perDay].sort((a, b) => Math.abs(b.f - b.a) - Math.abs(a.f - a.a)).slice(0, 10)
            .map(p => ({ date: p.date, act: r2(p.a), fc: r2(p.f), dev_pct: p.a >= 0.5 ? Math.round((p.f - p.a) / p.a * 100) : null }));
        for (const w of BT_SWEEP) {
            const e = btEval(days, valid, evalSweep, w, total, 'g1', true);
            if (e.day) res.sweep.push({ window: w, mae_day: r2(e.day.mae), nmae_day: r2(e.day.nmae), bias_day: r2(e.day.bias), nmae_hour: r2(e.hour.nmae),
                over30: e.perDay.filter(p => p.a >= 0.5 && Math.abs(p.f - p.a) / p.a > 0.3).length });
        }
        const totAct = evalSweep.reduce((s, x) => s + x.act.reduce((a, b) => a + b, 0), 0) || 1;
        for (const src of SOURCES) {
            const e = btEval(days, valid, evalSweep, LEARN_DAYS, x => x.src[src.name], 'g1', true);
            if (e.day) res.sources.push({ source: src.name, act: r2(e.day.act), share_pct: r2(100 * e.day.act / totAct), mae_day: r2(e.day.mae),
                nmae_day: r2(e.day.nmae), bias_day: r2(e.day.bias), nmae_hour: r2(e.hour.nmae) });
        }
        res.duration_s = Math.round((Date.now() - t0) / 1000);

        setV('backtest.result_json', JSON.stringify(res));
        setV('backtest.lastRun', new Date().toISOString());
        const v = res.variants.dayahead_hour;
        setV('backtest.dayahead_nmae_day_pct', v.nmae_day);
        setV('backtest.dayahead_nmae_hour_pct', v.nmae_hour);
        setV('backtest.dayahead_bias_day_kWh', v.bias_day);

        // Ausgabe
        const L = [];
        const pd = (x, n) => String(x ?? '–').padStart(n);
        L.push(`Zeitraum ${d0} bis ${d1}: ${days.length} Tage, gültig ${valid.length}, Dauer ${res.duration_s} s`);
        if (res.invalid.length) L.push('Ungültig: ' + res.invalid.join(', '));
        if (implaus.length) L.push('davon unplausibel: ' + implaus.join(', '));
        L.push('', `Fehler (Prognose − Ist), Lernfenster ${LEARN_DAYS} Tage. nMAE = MAE / Ist`);
        L.push('Variante                         | Tage | MAE Tag | nMAE Tag | Bias Tag | MAE Std | nMAE Std');
        const lab = { dayahead_hour: 'Day-Ahead, Stundenfaktoren', dayahead_day: 'Day-Ahead, Tagesfaktor', actualghi_hour: 'Ist-Strahlung, Stundenfaktoren', actualghi_day: 'Ist-Strahlung, Tagesfaktor' };
        for (const [k, x] of Object.entries(res.variants)) L.push(`${lab[k].padEnd(32)} | ${pd(x.days, 4)} | ${pd(x.mae_day, 7)} | ${pd(x.nmae_day, 7)}% | ${pd(x.bias_day, 8)} | ${pd(x.mae_hour, 7)} | ${pd(x.nmae_hour, 7)}%`);
        L.push('', 'Monat   | Tage | Ist kWh | Prog. kWh | MAE Tag | Tage >30%');
        for (const m of res.months) L.push(`${m.month} | ${pd(m.days, 4)} | ${pd(m.act, 7)} | ${pd(m.fc, 9)} | ${pd(m.mae_day, 7)} | ${pd(m.over30, 9)}`);
        L.push('', 'Schlechteste Tage: ' + res.worst.map(w => `${w.date} Ist ${w.act}/Prog ${w.fc} (${w.dev_pct ?? '–'} %)`).join(' | '));
        L.push('', `Lernfenster (gleiche ${evalSweep.length} Tage) | MAE Tag | nMAE Tag | Bias Tag | nMAE Std | Tage >30%`);
        for (const x of res.sweep) L.push(`${pd(x.window, 7)} Tage                  | ${pd(x.mae_day, 7)} | ${pd(x.nmae_day, 7)}% | ${pd(x.bias_day, 8)} | ${pd(x.nmae_hour, 7)}% | ${pd(x.over30, 9)}`);
        L.push('', 'Quelle      | Ist kWh | Anteil | MAE Tag | nMAE Tag | Bias Tag | nMAE Std');
        for (const x of res.sources) L.push(`${x.source.padEnd(11)} | ${pd(x.act, 7)} | ${pd(x.share_pct, 5)}% | ${pd(x.mae_day, 7)} | ${pd(x.nmae_day, 7)}% | ${pd(x.bias_day, 8)} | ${pd(x.nmae_hour, 7)}%`);
        log('PV-ICON Backtest:\n' + L.join('\n'), 'warn');
    } catch (e) {
        log('PV-ICON Backtest fehlgeschlagen: ' + e.message, 'warn');
    } finally {
        btBusy = false;
        setV('backtest.running', false);
    }
}

(async () => {
    await initStates();
    try { await bootstrap(); } catch (e) { log('PV-ICON: Nachholen der Lerntage fehlgeschlagen: ' + e.message, 'warn'); }
    await updateForecast();
    const f = parse(getV('learn.factors_json') || 'null', null);
    const run = getV('forecast.run_init_ts');
    log(`PV-ICON: gestartet | Lerntage ${getV('learn.days_used')} | heute ${getV('forecast.pv_today_kWh') ?? '–'} kWh, morgen ${getV('forecast.pv_tomorrow_kWh') ?? '–'} kWh | Fehler: ${getV('forecast.error') || 'keiner'}`
        + (run ? ` | Lauf ${new Date(run).toISOString().slice(0, 16)} UTC` : '')
        + (f ? ` | Faktoren 8–18 Uhr: ${f.slice(8, 19).map(v => v.toFixed(1)).join(' ')}` : ''), 'warn');
    // bestehende Snapshots (z. B. von der Vorversion) ins Archiv übernehmen
    for (const w of ['dayahead', 'morning']) {
        const d = getV(`snap.${w}_date`), a = archiveGet();
        if (d && !(a[d] && a[d][w]) && getV(`snap.${w}_kWh`) !== null) {
            archivePut(d, w, getV(`snap.${w}_kWh`), parse(getV(`snap.${w}_hourly_json`) || '[]', []));
            log(`PV-ICON: Snapshot ${w} ${d} ins Archiv übernommen`, 'warn');
        }
    }
    // Snapshot nachholen, wenn das Skript kurz nach dem Termin (neu) gestartet wurde
    const hNow = new Date().getHours() + new Date().getMinutes() / 60;
    if (hNow >= 22 && hNow < 22 + CATCHUP_H && getV('snap.dayahead_date') !== dateStr(dayStart(1))) {
        log('PV-ICON: Day-Ahead-Snapshot wird nachgeholt', 'warn');
        await snapshot('dayahead', true);
    }
    if (hNow >= 6 && hNow < 6 + CATCHUP_H && getV('snap.morning_date') !== dateStr(dayStart(0))) {
        log('PV-ICON: Morgen-Snapshot wird nachgeholt', 'warn');
        await snapshot('morning', true);
    }
    log(`PV-ICON: Snapshots | Day-Ahead ${getV('snap.dayahead_date') || '–'}: ${getV('snap.dayahead_kWh') ?? '–'} kWh | Morgen ${getV('snap.morning_date') || '–'}: ${getV('snap.morning_kWh') ?? '–'} kWh`, 'warn');
    on({ id: BASE + 'backtest.run', val: true, ack: false }, () => { setState(BASE + 'backtest.run', false, true); runBacktest('Knopfdruck'); });
    if (BT_CRON) schedule(BT_CRON, () => runBacktest('monatlich'));
    schedule(FETCH_CRON, updateForecast);
    schedule(META_CRON, checkRun);
    schedule(SNAP_DA_CRON, () => snapshot('dayahead', true));
    schedule(SNAP_MO_CRON, () => snapshot('morning', true));
    schedule(FINALIZE_CRON, () => finalizeYesterday(true));
})();
