/*
 * Wärmepumpen-Budget: Stützung der Wärmepumpe durch DTUoB_WP (OpenDTU-OnBattery, Dynamic Power Limiter) nur so weit,
 * wie die PV des Zieltags über den Verbrauch hinaus liefert und die Batterie es hergibt. Gilt rund um die Uhr.
 *
 * Zyklus: von Abend zu Abend. Abend = PV < Hausverbrauch für ABEND_MIN, frühestens Sonnenuntergang − ABEND_VOR_SU_H,
 *         spätestens Sonnenuntergang. Ab dann ist der Zieltag morgen; was DTUoB_WP in dieser Nacht und am Zieltag selbst
 *         abgibt, zählt gegen dessen Budget.
 * Jede Minute: Rest = kleinerer Wert aus
 *           Budget   = PV-Ertrag des Zieltags bis jetzt + ICON-Prognose für den Rest des Zieltags − (Verbrauch Ø 14 Tage + PUFFER)
 *                      − seit Zyklusbeginn abgegeben (vor Mitternacht: volle Prognose für morgen; am Zieltag ersetzt das Ist
 *                      die vergangenen Stunden, so folgt das Budget dem, was wirklich kommt)
 *           Zukunft  = so viel, dass die Batterie bis zum Morgen nach der nächsten Nacht nie unter SOC_MIN + Puffer fällt:
 *                      Batterie Stunde für Stunde vorausgerechnet mit ICON-PV (heute, morgen), Hausverbrauch Ø je Stunde,
 *                      voll bei 100 %; Puffer wächst mit PUFFER je 24 h. Ist morgen trüb, wird sie kleiner, auch schon nachts.
 *                      Kein festes SOC-Ziel: ist morgen sonnig, füllt die PV morgen die Batterie wieder; ist morgen trüb,
 *                      verlangt die Vorausrechnung von selbst eine volle Batterie.
 *         Stützung aus (Modus 1), sobald Rest <= 0; wieder an (Modus 0) erst, wenn Rest >= HYST_SOC % der Kapazität.
 *         Fehlen Werte, ist die Stützung aus.
 * Morgen: PV > Hausverbrauch für MORGEN_MIN, frühestens Sonnenaufgang, spätestens Sonnenaufgang + MORGEN_NACH_SA_H.
 *         Nacht mitschreiben, Ø-Werte aus der History neu rechnen.
 *
 * Hausverbrauch:  alias.0.VenusOS.AC_Consumption_P (Venus, Eingang und Ausgang des MP2, ohne Wärmepumpe)
 * PV:             live aus Venus (DC aller MPPT + PV-Wechselrichter am Netz); je Stunde aus den Lerntagen des ICON-Skripts
 *                 (die IDs DC_MPPT_288_P usw. dort sind nur History-Namen, keine Datenpunkte)
 * Nachtbedarf:    je Nacht Summe (Verbrauch − PV) je Stunde von Abend bis Morgen, gleiche Regeln wie oben, je Stunde
 * Befehle an die DTU über sendTo('mqtt.0', 'sendMessage2Client') ohne retain (retained Befehle legen OpenDTU-OnBattery
 * lahm, Issue #1629); erst ab mqtt-Adapter 5, der retain von sendTo übernimmt. Nach einem Neustart der DTU steht der
 * Modus wieder auf 0, deshalb prüft das Skript ihn jede Minute und setzt ihn höchstens alle 2 min neu.
 * Skript stoppen: hat es die Stützung abgeschaltet, setzt es den Modus wieder auf 0 (Zustand ohne Skript).
 * Datenpunkte unter 0_userdata.0.wpBudget.*. Dauerskript, Ausgabe auf Loglevel "warn".
 */

// ======================= Konfiguration =======================
const SCHALTEN         = true;     // false: nur rechnen und mitschreiben, Modus nicht setzen
const PUFFER_KWH       = 2;        // gilt für 24 h; die Nacht bekommt ihren Anteil nach Stunden
const FENSTER_TAGE     = 14;
const KAPAZITAET_KWH   = 22;
const SOC_MIN          = 20;       // ESS-Abschaltung in %
const HYST_SOC         = 1;        // wieder einschalten erst ab so viel % SOC Rest
const ABEND_VOR_SU_H   = 2,  ABEND_MIN  = 15;
const MORGEN_NACH_SA_H = 4,  MORGEN_MIN = 15;
const BASE             = '0_userdata.0.wpBudget.';
const HIST             = 'history.0';
const ICON_HOURLY      = '0_userdata.0.pvForecastIcon.forecast.pv_hourly_json';
const ICON_LEARN       = '0_userdata.0.pvForecastIcon.learn.days_json';
const CONS_ID          = 'alias.0.VenusOS.AC_Consumption_P';
const PV_IDS           = ['alias.0.VenusOS.DC_PV_total_P', 'alias.0.VenusOS.AC_MP2_PVonGrid_P'];   // alle MPPT + Growatt und HMS
const SOC_ID           = 'mqtt.1.N.<venus-id>.battery.291.Soc';   // <venus-id>: Portal-ID von Venus OS eintragen
const DPL_MODE_ID      = 'mqtt.0.DTUoB_WP.powerlimiter.status.mode';
const DPL_MODE_TOPIC   = 'DTUoB_WP/powerlimiter/cmd/mode';
const YIELD_ID         = 'mqtt.0.DTUoB_WP.<seriennummer>.0.yieldtotal';           // kWh, Gesamtzähler; Seriennummer des Wechselrichters eintragen
const MQTT_INST        = 'mqtt.0';
const MAX_LUECKE_MIN   = 30;       // Tag ohne Verbrauchswert länger als das: nicht im Mittel
const KEEP_ZYKLEN      = 60;
// =============================================================

const H = 3600000;
const r2 = v => v === null || v === undefined ? null : Math.round(v * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayStart(off, from) { const d = from ? new Date(from) : new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d; }
const dayOf = s => new Date(s + 'T00:00:00');
const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
// Zahl aus einem Datenpunkt; Venus über MQTT liefert Text wie {"value":31.6}
const num = id => {
    const s = getState(id);
    let v = s ? s.val : null;
    if (typeof v === 'string' && v.trim().startsWith('{')) { const o = parse(v, null); v = o && o.value !== undefined ? o.value : null; }
    v = v === null || v === undefined || v === '' ? NaN : Number(v);
    return isFinite(v) ? v : null;
};

const HIST_CFG = { enabled: true, changesOnly: true, debounceTime: 0, retention: 31536000 };
const DEFS = [
    ['phase',             'Phase (Tag / Nacht)',                                         'string',  '',    'Tag', false],
    ['zieltag',           'Zieltag des Budgets',                                         'string',  '',    '',    false],
    ['prognose_kWh',      'ICON-Prognose für den Zieltag',                               'number',  'kWh', null,  true],
    ['verbrauch_avg_kWh', 'Verbrauch Ø der letzten 14 Tage',                             'number',  'kWh', null,  true],
    ['nacht_avg_kWh',     'Nachtbedarf Ø der letzten 14 Nächte',                         'number',  'kWh', null,  true],
    ['nacht_stunden',     'Nachtlänge Ø',                                                'number',  'h',   null,  false],
    ['nacht_profil_json', 'Restbedarf und Reststunden je Stunde ab 12 Uhr {R[25], H[25]}', 'string', '',   '{}',  false],
    ['pv_ist_kWh',        'PV-Ertrag heute seit Mitternacht',                            'number',  'kWh', null,  true],
    ['erwartet_kWh',      'Zieltag erwartet = PV Ist bis jetzt + ICON-Rest',             'number',  'kWh', null,  true],
    ['budget_kWh',        'Budget = erwartet − (Verbrauch Ø + Puffer)',                  'number',  'kWh', null,  true],
    ['reserve_kWh',       'was bis zum Morgen nach der nächsten Nacht in der Batterie bleiben muss (Batterie über SOC_MIN − Zukunft)', 'number', 'kWh', null, true],
    ['zukunft_kWh',       'Zukunft: so viel darf die Wärmepumpe noch nehmen, ohne dass die Batterie im Horizont unter SOC_MIN + Puffer fällt', 'number', 'kWh', null, true],
    ['engpass',           'knappste Stelle der Vorausrechnung (Uhrzeit, kWh über SOC_MIN + Puffer ohne Wärmepumpe)', 'string', '', '', false],
    ['pv_rest_kWh',       'ICON-Prognose für den Rest von heute (wie pv_remaining_today_kWh, minutengenau)', 'number', 'kWh', null, true],
    ['batterie_kWh',      'Batterie-Seite (= Zukunft)',                                  'number', 'kWh', null, true],
    ['freigabe_kWh',      'FREIGABE: so viel darf die Wärmepumpe jetzt noch bekommen (kleinster Wert aller Grenzen, mindestens 0)', 'number', 'kWh', null, true],
    ['rest_kWh',          'Rest = kleinerer Wert aus Budget − abgegeben und Batterie (kann negativ sein)', 'number', 'kWh', null, true],
    ['abgegeben_kWh',     'DTUoB_WP seit Zyklusbeginn (Abend) abgegeben',                'number',  'kWh', null,  true],
    ['stuetzung',         'Stützung durch DTUoB_WP gewünscht (Modus 0)',                 'boolean', '',    true,  true],
    ['naechte_json',      'Zyklen Abend bis Abend [{zieltag, abend, morgen, ende, soc_abend, soc_morgen, soc_ende, prognose, budget, abgegeben_nacht, abgegeben, schaltungen}]', 'string', '', '[]', false],
    ['fehler',            'Fehler (leer = OK)',                                          'string',  '',    '',    false],
];

const mem = {};
function setV(p, v) { mem[p] = v; setState(BASE + p, v, true); }
function getV(p) { if (p in mem) return mem[p]; const s = getState(BASE + p); return (s && s.val !== undefined) ? s.val : null; }

async function initStates() {
    for (const [p, name, type, unit, def, hist] of DEFS) {
        if (existsObject(BASE + p)) continue;
        const common = { name, type, unit, role: type === 'number' ? 'value' : (type === 'boolean' ? 'indicator' : 'text'), read: true, write: false };
        if (hist && HIST) common.custom = { [HIST]: HIST_CFG };
        await createStateAsync(BASE + p, def, common);
    }
}

// Sonnenauf- und -untergang (Standort aus den Einstellungen der javascript-Instanz); ohne Standort 07:00 / 17:00
// getAstroDate liefert ein Date aus dem Adapter, nicht aus der Skript-Sandbox: kein instanceof, nur getTime prüfen
let astroWarn = false;
function astro(was, d) {
    const t = getAstroDate(was, d);
    const ms = t && typeof t.getTime === 'function' ? t.getTime() : NaN;
    if (isFinite(ms)) return ms;
    if (!astroWarn) { astroWarn = true; log(`WP-Budget: kein Sonnenstand (getAstroDate lieferte ${t}; Breiten-/Längengrad in der javascript-Instanz?), nehme 07:00 / 17:00`, 'warn'); }
    return dayStart(0, d).getTime() + (was === 'sunrise' ? 7 : 17) * H;
}

// ---------- Ø-Werte aus der History ----------
function hist(id, start, end) {
    return new Promise((resolve, reject) => {
        getHistory(HIST, { id, start, end, aggregate: 'none', ignoreNull: false, count: 2000000 }, (err, res) => {
            if (err) return reject(new Error(`getHistory ${id}: ${err}`));
            resolve((Array.isArray(res) ? res : []).map(p => ({ ts: p.ts, val: p.val === null || p.val === undefined ? null : Number(p.val) }))
                .sort((a, b) => a.ts - b.ts));
        });
    });
}

// Verbrauch je lokaler Stunde eines Tages als Stufenfunktion (letzter Wert gilt), null beendet die Stufe.
// -> {h: [24] kWh, ok: kein Abstand > MAX_LUECKE_MIN}
function stundenVerbrauch(pts, d) {
    const ds = d.getTime(), de = dayStart(1, d).getTime();
    const h = new Array(24).fill(0);
    let cur = null, last = ds, ok = true, prevTs = ds;
    const add = (a, b, w) => {
        while (a < b) {
            const e = Math.min(b, new Date(a).setMinutes(60, 0, 0));
            h[new Date(a).getHours()] += Math.max(w, 0) * (e - a) / H / 1000;
            a = e;
        }
    };
    for (const p of pts) {
        if (p.ts <= ds) { cur = p.val; continue; }
        if (p.ts >= de) break;
        if (p.ts - prevTs > MAX_LUECKE_MIN * 60000) ok = false;
        if (cur !== null && isFinite(cur)) add(last, p.ts, cur);
        cur = p.val; last = p.ts; prevTs = p.ts;
    }
    if (de - prevTs > MAX_LUECKE_MIN * 60000) ok = false;
    if (cur !== null && isFinite(cur)) add(last, de, cur);
    return { h, ok };
}

// Stunden-Takt einer Nacht: Takt 0 = 12 Uhr am Abendtag, Takt 12 = 0 Uhr, Takt 23 = 11 Uhr am Morgen
const takt = ts => { const h = new Date(ts).getHours(); return h >= 12 ? h - 12 : h + 12; };

// Nacht von Tag a (abends) bis Tag b (morgens) aus Stundenwerten, gleiche Regeln wie live
// -> {kWh, R[25], H[25]}: R[s] = Bedarf von Takt s bis zum Morgen, H[s] = Nachtstunden ab Takt s
function nachtBedarf(dA, consA, pvA, dB, consB, pvB) {
    const cons = [...consA.slice(12), ...consB.slice(0, 12)], pv = [...pvA.slice(12), ...pvB.slice(0, 12)];
    const su = astro('sunset', dA), sa = astro('sunrise', dB);
    const s0 = takt(su - ABEND_VOR_SU_H * H), s1 = takt(su);
    let start = s1;
    for (let s = s0; s <= s1; s++) if (pv[s] < cons[s]) { start = s; break; }
    const e0 = takt(sa), e1 = Math.min(23, takt(sa + MORGEN_NACH_SA_H * H));
    let ende = e1;
    for (let s = e0; s <= e1; s++) if (pv[s] >= cons[s] && cons[s] > 0) { ende = s; break; }
    const R = new Array(25).fill(0), Hs = new Array(25).fill(0);
    for (let s = 23; s >= 0; s--) {
        const in_ = s >= start && s < ende;
        R[s] = R[s + 1] + (in_ ? Math.max(0, cons[s] - pv[s]) : 0);
        Hs[s] = Hs[s + 1] + (in_ ? 1 : 0);
    }
    return { kWh: R[0], R, H: Hs };
}

async function mittelwerteNeu() {
    const heute = dayStart(0);
    const start = dayStart(-(FENSTER_TAGE + 1)).getTime();
    const pts = await hist(CONS_ID, start - 12 * H, heute.getTime());
    const learn = {};
    for (const x of parse((getState(ICON_LEARN) || {}).val || '[]', [])) learn[x.date] = x.act;
    const tage = [];   // älteste zuerst, bis gestern
    for (let off = -(FENSTER_TAGE + 1); off <= -1; off++) {
        const d = dayStart(off);
        tage.push({ d, date: dateStr(d), ...stundenVerbrauch(pts.filter(p => p.ts >= d.getTime() - 12 * H && p.ts < dayStart(1, d).getTime()), d) });
    }
    const voll = tage.filter(t => t.ok).slice(-FENSTER_TAGE);
    const nachts = [];
    for (let i = 1; i < tage.length; i++) {
        const a = tage[i - 1], b = tage[i];
        if (!a.ok || !b.ok || !learn[a.date] || !learn[b.date]) continue;
        nachts.push(nachtBedarf(a.d, a.h, learn[a.date], b.d, b.h, learn[b.date]));
    }
    const n14 = nachts.slice(-FENSTER_TAGE);
    if (voll.length < 7 || n14.length < 7) throw new Error(`zu wenige vollständige Tage (${voll.length}) oder Nächte (${n14.length})`);
    const avg = voll.reduce((s, t) => s + t.h.reduce((a, b) => a + b, 0), 0) / voll.length;
    const mean = k => Array.from({ length: 25 }, (_, s) => n14.reduce((sum, n) => sum + n[k][s], 0) / n14.length);
    const prof = { R: mean('R').map(v => Math.round(v * 1000) / 1000), H: mean('H').map(v => Math.round(v * 100) / 100),
        C: Array.from({ length: 24 }, (_, h) => Math.round(voll.reduce((s, t) => s + t.h[h], 0) / voll.length * 1000) / 1000) };   // Haus je Stunde
    setV('verbrauch_avg_kWh', r2(avg));
    setV('nacht_avg_kWh', r2(Math.max(...prof.R)));
    setV('nacht_stunden', r2(Math.max(...prof.H)));
    setV('nacht_profil_json', JSON.stringify(prof));
    log(`WP-Budget: Ø Verbrauch ${r2(avg)} kWh (${voll.length} Tage), Ø Nachtbedarf ${getV('nacht_avg_kWh')} kWh in ${getV('nacht_stunden')} h (${n14.length} Nächte)`, 'warn');
}

// ---------- Budget, Reserve, Rest ----------
function prognoseFuer(zieltag) {
    const d0 = dayOf(zieltag).getTime(), d1 = dayStart(1, new Date(d0)).getTime();
    const rows = parse((getState(ICON_HOURLY) || {}).val || '[]', []).filter(([ts]) => ts >= d0 && ts < d1);
    if (!rows.some(([ts]) => ts >= d0 + 10 * H && ts < d0 + 14 * H)) return null;   // Zieltag nicht abgedeckt
    return rows.reduce((s, [, v]) => s + v, 0);
}

// ICON-Prognose für den Zieltag ab jetzt (laufende Stunde anteilig); null, wenn der Zieltag nicht abgedeckt ist
function prognoseRest(zieltag, ts) {
    if (prognoseFuer(zieltag) === null) return null;
    const d0 = dayOf(zieltag).getTime(), d1 = dayStart(1, new Date(d0)).getTime();
    const h0 = new Date(ts).setMinutes(0, 0, 0), f = (ts - h0) / H;
    return parse((getState(ICON_HOURLY) || {}).val || '[]', []).filter(([t]) => t >= d0 && t < d1)
        .reduce((s, [t, v]) => s + (t > h0 ? v : t === h0 ? v * (1 - f) : 0), 0);
}

// Budget: am Zieltag Ist bis jetzt + Prognose für den Rest, am Vorabend die volle Prognose
function budget() {
    const z = getV('zieltag'), avg = getV('verbrauch_avg_kWh'), now = Date.now();
    const p = prognoseFuer(z), rest = prognoseRest(z, now);
    const ist = z === dateStr(dayStart(0)) ? pvIst.kWh : 0;
    setV('prognose_kWh', r2(p));
    if (rest === null || avg === null || ist === null) { setV('erwartet_kWh', null); return null; }
    const erw = ist + rest;
    setV('erwartet_kWh', r2(erw));
    const b = Math.max(0, erw - (avg + PUFFER_KWH));
    setV('budget_kWh', r2(b));
    return b;
}

// PV-Ertrag heute: beim Start aus der History, danach jede Minute die aktuelle Leistung aufsummiert
const pvIst = { date: null, kWh: null };
async function pvIstLaden() {
    const d = dayStart(0), now = Date.now();
    let kWh = 0;
    for (const id of PV_IDS) {
        const pts = await hist(id, d.getTime() - 12 * H, now);
        let cur = null, last = d.getTime();
        for (const q of pts) {
            if (q.ts <= d.getTime()) { cur = q.val; continue; }
            if (cur !== null && isFinite(cur)) kWh += Math.max(0, cur) * (q.ts - last) / H / 1000;
            cur = q.val; last = q.ts;
        }
        if (cur !== null && isFinite(cur)) kWh += Math.max(0, cur) * (now - last) / H / 1000;
    }
    pvIst.date = dateStr(d); pvIst.kWh = kWh;
    setV('pv_ist_kWh', r2(kWh));
}
function pvIstMinute() {
    const heute = dateStr(dayStart(0));
    if (pvIst.kWh === null) return;
    if (pvIst.date !== heute) { pvIst.date = heute; pvIst.kWh = 0; }
    pvIst.kWh += pvW() / 1000 / 60;
    setV('pv_ist_kWh', r2(pvIst.kWh));
}

// Vorausrechnung bis zum Morgen nach der nächsten Nacht: wie viel darf die Wärmepumpe ab jetzt noch nehmen?
// Batterie (kWh über SOC_MIN) je Stunde: + ICON-PV − Haus (Ø je Stunde), höchstens voll; muss über dem Puffer-Anteil bleiben.
// -> {frei, engpassTs, engpassKWh} oder null
function zukunft(ts, soc, phase) {
    const prof = parse(getV('nacht_profil_json') || '{}', {});
    if (!Array.isArray(prof.C) || prof.C.length < 24 || soc === null) return null;
    const rows = parse((getState(ICON_HOURLY) || {}).val || '[]', []);
    const pv = new Map(rows.map(([t, v]) => [t, v]));
    const zt = getV('zieltag');
    // ohne Prognose für den nächsten PV-Tag keine Vorausrechnung
    const pvTag = phase === 'Nacht' ? zt : dateStr(dayStart(1));
    if (prognoseFuer(pvTag) === null) return null;
    const ende = astro('sunrise', phase === 'Nacht' ? dayStart(1, dayOf(zt)) : dayStart(2)) + 2 * H;
    const voll = (100 - SOC_MIN) / 100 * KAPAZITAET_KWH, e0 = (soc - SOC_MIN) / 100 * KAPAZITAET_KWH;
    const schritte = [];   // [Ende ms, PV − Haus kWh]
    for (let a = ts; a < ende; ) {
        const h0 = new Date(a).setMinutes(0, 0, 0), e = Math.min(ende, h0 + H), f = (e - a) / H;
        schritte.push([e, (pv.get(h0) || 0) * f - prof.C[new Date(a).getHours()] * f]);
        a = e;
    }
    const lauf = x => {   // -> knappste Stelle {ts, kWh} bei x kWh für die Wärmepumpe ab jetzt
        let e = e0 - x, min = { ts, kWh: e };
        for (const [t, d] of schritte) {
            e = Math.min(voll, e + d);
            const k = e - PUFFER_KWH * (t - ts) / (24 * H);
            if (k < min.kWh) min = { ts: t, kWh: k };
        }
        return min;
    };
    const ohne = lauf(0);
    if (ohne.kWh <= 0) return { frei: 0, engpassTs: ohne.ts, engpassKWh: ohne.kWh };
    let lo = 0, hi = Math.max(0, e0);
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (lauf(m).kWh >= 0) lo = m; else hi = m; }
    return { frei: lo, engpassTs: ohne.ts, engpassKWh: ohne.kWh };
}

const pvW = () => PV_IDS.reduce((s, id) => s + Math.max(0, num(id) || 0), 0);

// ---------- DTU-Modus ----------
let mqttOk = false, lastSend = 0, sendFehler = false;
async function mqttPruefen() {
    const o = await getObjectAsync('system.adapter.' + MQTT_INST);
    const v = o && o.common && o.common.version;
    mqttOk = !!v && Number(String(v).split('.')[0]) >= 5;
    if (!mqttOk) { setV('fehler', `${MQTT_INST} Version ${v || '?'}: retain wird erst ab Version 5 übernommen, schalte nicht`); log('WP-Budget: ' + getV('fehler'), 'warn'); }
}

function modusSetzen(stuetzen, grund) {
    const soll = stuetzen ? 0 : 1;
    if (getV('stuetzung') !== stuetzen) {
        setV('stuetzung', stuetzen);
        const rec = offen(); if (rec) rec.schaltungen = (rec.schaltungen || 0) + 1;
        log(`WP-Budget: Stützung ${stuetzen ? 'an' : 'aus'} (${grund})`, 'warn');
    }
    if (!SCHALTEN || !mqttOk) return;
    if (num(DPL_MODE_ID) === soll || Date.now() - lastSend < 2 * 60000) return;
    lastSend = Date.now();
    sendTo(MQTT_INST, 'sendMessage2Client', { topic: DPL_MODE_TOPIC, message: String(soll), retain: false });
    setTimeout(() => {
        const ist = num(DPL_MODE_ID);
        if (ist !== soll && !sendFehler) log(`WP-Budget: DPL-Modus ist 60 s nach dem Befehl nicht ${soll} (steht auf ${ist ?? '–'}), versuche weiter alle 2 min`, 'warn');
        if (ist === soll && sendFehler) log(`WP-Budget: DPL-Modus jetzt ${soll}`, 'warn');
        sendFehler = ist !== soll;
    }, 60000);
}

// ---------- Ablauf ----------
let unterMin = 0, ueberMin = 0;   // Minuten am Stück PV < bzw. > Hausverbrauch
let zyklen = [];                  // wird beim Start aus naechte_json geladen
const offen = () => zyklen.length && !zyklen[zyklen.length - 1].ende ? zyklen[zyklen.length - 1] : null;
const speichern = () => setV('naechte_json', JSON.stringify(zyklen));

// neuer Zyklus; der offene wird abgeschlossen. phase 'Nacht' = Abendbeginn, 'Tag' = Start des Skripts tagsüber
function zyklusBeginnen(zieltag, phase) {
    const alt = offen(), soc = r2(num(SOC_ID));
    if (alt) {
        alt.ende = hhmm(Date.now()); alt.soc_ende = soc;
        const nachts = alt.abgegeben_nacht ?? alt.abgegeben;
        log(`WP-Budget: Zieltag ${alt.zieltag} abgeschlossen: Budget ${alt.budget ?? '–'} kWh, abgegeben ${alt.abgegeben} kWh `
            + `(nachts ${nachts}, tagsüber ${r2(alt.abgegeben - nachts)}), ${alt.schaltungen} Schaltungen`, 'warn');
    }
    setV('zieltag', zieltag);
    budget();
    zyklen.push({ zieltag, abend: phase === 'Nacht' ? hhmm(Date.now()) : null, morgen: null, ende: null,
        soc_abend: soc, soc_morgen: null, soc_ende: null, prognose: getV('prognose_kWh'), budget: getV('budget_kWh'),
        abgegeben_nacht: null, abgegeben: 0, schaltungen: 0, yield0: num(YIELD_ID) });
    zyklen = zyklen.slice(-KEEP_ZYKLEN);
    setV('phase', phase);
    setV('abgegeben_kWh', 0);
    speichern();
    pruefen();
    log(`WP-Budget: ${phase === 'Nacht' ? 'Abend' : 'Start tagsüber'} ${hhmm(Date.now())}, Zieltag ${zieltag}: Prognose ${getV('prognose_kWh') ?? '–'} kWh, erwartet ${getV('erwartet_kWh') ?? '–'} kWh, `
        + `Budget ${getV('budget_kWh') ?? '–'}, SOC ${soc ?? '–'} %, Zukunft ${getV('zukunft_kWh') ?? '–'} (knappste Stelle ${getV('engpass') || '–'}), Freigabe ${getV('freigabe_kWh') ?? '–'} kWh`, 'warn');
}

async function morgenBeenden() {
    const rec = offen();
    if (rec) {
        rec.morgen = hhmm(Date.now()); rec.soc_morgen = r2(num(SOC_ID)); rec.abgegeben_nacht = rec.abgegeben;
        log(`WP-Budget: Morgen ${rec.morgen}, Zieltag ${rec.zieltag}: nachts abgegeben ${rec.abgegeben} kWh von Budget ${rec.budget ?? '–'}, `
            + `SOC ${rec.soc_abend ?? '–'} → ${rec.soc_morgen ?? '–'} %`, 'warn');
    }
    setV('phase', 'Tag');
    speichern();
    try { await mittelwerteNeu(); setV('fehler', mqttOk || !SCHALTEN ? '' : getV('fehler')); }
    catch (e) { setV('fehler', e.message); log('WP-Budget: ' + e.message, 'warn'); }
    pruefen();
}

// jede Minute und bei neuer Prognose
function pruefen() {
    const rec = offen(), phase = getV('phase');
    const now = Date.now(), b = budget(), soc = num(SOC_ID), y = num(YIELD_ID);
    const pvRest = prognoseRest(dateStr(dayStart(0)), now);
    const zk = zukunft(now, soc, phase);
    setV('pv_rest_kWh', r2(pvRest));
    setV('zukunft_kWh', zk ? r2(zk.frei) : null);
    setV('engpass', zk ? `${new Date(zk.engpassTs).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${r2(zk.engpassKWh)} kWh` : '');
    if (rec && y !== null) {
        if (rec.yield0 === null || y < rec.yield0) rec.yield0 = y - (rec.abgegeben || 0);   // Zähler fehlte oder ist zurückgesprungen
        rec.abgegeben = r2(y - rec.yield0);
    }
    if (!rec || b === null || soc === null || !zk) {
        setV('rest_kWh', null); setV('freigabe_kWh', 0);
        modusSetzen(false, 'Werte fehlen, Stützung aus');
        return;
    }
    // Batterie-Seite: Vorausrechnung bis zum Morgen nach der nächsten Nacht (tags und nachts gleich)
    const bat = zk.frei;
    const rest = Math.min(b - rec.abgegeben, bat);
    rec.prognose = getV('prognose_kWh'); rec.budget = r2(b);
    setV('reserve_kWh', r2((soc - SOC_MIN) / 100 * KAPAZITAET_KWH - zk.frei)); setV('batterie_kWh', r2(bat));
    setV('rest_kWh', r2(rest)); setV('freigabe_kWh', r2(Math.max(0, rest))); setV('abgegeben_kWh', rec.abgegeben);
    speichern();
    const an = getV('stuetzung') === true;
    const hyst = HYST_SOC / 100 * KAPAZITAET_KWH;
    const grund = rest !== bat ? `Budget: noch ${r2(b - rec.abgegeben)} von ${r2(b)} kWh (erwartet ${getV('erwartet_kWh')} kWh)`
        : `Zukunft: ${r2(zk.frei)} kWh frei, knappste Stelle ${getV('engpass')}`;
    modusSetzen(an ? rest > 0 : rest >= hyst, grund);
}

function minute() {
    pvIstMinute();
    const now = Date.now(), heute = dayStart(0), p = pvW(), c = num(CONS_ID);
    const sa = astro('sunrise', heute), su = astro('sunset', heute), abendAb = su - ABEND_VOR_SU_H * H;
    const rec = offen(), phase = getV('phase');
    unterMin = phase === 'Tag' && now >= abendAb && c !== null && p < c ? unterMin + 1 : 0;
    ueberMin = phase === 'Nacht' && now >= sa && c !== null && p > c ? ueberMin + 1 : 0;
    // kein oder überholter Zyklus (erster Start, Skript lief nicht): neu beginnen, passend zur Tageszeit
    if (!rec || rec.zieltag < dateStr(heute) || (phase === 'Tag' && rec.zieltag !== dateStr(heute))) {
        if (now < sa) zyklusBeginnen(dateStr(heute), 'Nacht');
        else if (now >= su) zyklusBeginnen(dateStr(dayStart(1)), 'Nacht');
        else zyklusBeginnen(dateStr(heute), 'Tag');
        return;
    }
    if (phase === 'Tag' && now >= abendAb && (unterMin >= ABEND_MIN || now >= su)) { zyklusBeginnen(dateStr(dayStart(1)), 'Nacht'); return; }
    if (phase === 'Nacht' && rec.zieltag === dateStr(heute) && now >= sa && (ueberMin >= MORGEN_MIN || now >= sa + MORGEN_NACH_SA_H * H)) { morgenBeenden(); return; }
    pruefen();
}

onStop(cb => {
    // Skript aus: hat es die Stützung abgeschaltet, wieder einschalten (Zustand ohne Skript)
    if (SCHALTEN && mqttOk && getV('stuetzung') === false && num(DPL_MODE_ID) !== 0)
        sendTo(MQTT_INST, 'sendMessage2Client', { topic: DPL_MODE_TOPIC, message: '0', retain: false });
    cb();
}, 2000);

(async () => {
    await initStates();
    await mqttPruefen();
    try { await mittelwerteNeu(); } catch (e) { setV('fehler', e.message); log('WP-Budget: ' + e.message, 'warn'); }
    try { await pvIstLaden(); } catch (e) { setV('fehler', e.message); log('WP-Budget: PV-Ertrag heute nicht lesbar: ' + e.message, 'warn'); }
    zyklen = parse(getV('naechte_json') || '[]', []);
    log(`WP-Budget: gestartet | Phase ${getV('phase')} | Ø Verbrauch ${getV('verbrauch_avg_kWh') ?? '–'} kWh, Ø Nachtbedarf ${getV('nacht_avg_kWh') ?? '–'} kWh `
        + `| Schalten ${SCHALTEN && mqttOk ? 'ja' : 'nein'} | DPL-Modus ${num(DPL_MODE_ID) ?? '–'} | PV ${Math.round(pvW())} W, Haus ${num(CONS_ID) ?? '–'} W, `
        + `SOC ${r2(num(SOC_ID)) ?? '–'} %, PV heute ${getV('pv_ist_kWh') ?? '–'} kWh | Sonne ${hhmm(astro('sunrise', dayStart(0)))}–${hhmm(astro('sunset', dayStart(0)))}`, 'warn');
    minute();
    schedule('* * * * *', minute);
    on({ id: ICON_HOURLY, change: 'ne' }, pruefen);
})();
