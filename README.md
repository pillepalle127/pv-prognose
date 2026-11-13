# PV-Prognose: VRM gegen ICON-D2

Ich vergleiche zwei PV-Prognosen mit dem, was meine Anlage wirklich erzeugt: die von Victron VRM und meine eigene aus DWD ICON-D2. ioBroker sammelt nur die Daten, ausgewertet wird in Python.

Mein Eindruck aus den ersten Tagen: ICON ist VRM bei heute und morgen überlegen. Im Fehler, in der Konstanz und in der Verfügbarkeit eines brauchbaren Werts. Das will ich mit 2–3 Wochen Daten prüfen.

Ich werde mich in den nächsten Tagen für ICON entscheiden und dann die Trigger darauf stützen. Der Vergleich läuft weiter.

## Anlage

- DC: sechs Victron-MPPT (288, 291, 292, 293, 294, 296).
- AC: Growatt-MIC und Hoymiles über [OpenDTU](https://github.com/tbnobody/OpenDTU) (in den Skripten „Growatt“ und „HMS Garage“). Venus OS erfasst beide als PV-Inverter.
- Deutlich mehr als zwei Modulausrichtungen.
- DTUoB_WP ist kein PV-Erzeuger. DTUoB steht für [OpenDTU-OnBattery](https://github.com/hoylabs/OpenDTU-OnBattery). Er speist aus der Batterie die Wärmepumpe und gehört nicht in die PV-Summe. Hoymiles, ca. 2 kW. Er stützt die Wärmepumpe nach Bedarf und regelt das selbst; von außen wird die Stützung nur an- oder abgeschaltet.
- Die Wärmepumpe braucht ihre Energie vor allem abends (Warmwasser) und nachts (Heizkurve nach Außentemperatur).
- Batterie ca. 22 kWh, ESS-Abschaltung bei 20 % SOC.

## Vorgaben

- Datenquelle bleibt beim DWD: ICON-D2 über Open-Meteo, für mehr als 48 h ICON-EU. Keine Fremddienste wie Solcast oder Forecast.Solar.
- Robuste Auswertung statt Optimierung um wenige Prozent.
- Keine Annahmen oder erfundenen Werte. Was fehlt, wird erfragt.
- Die Wärmepumpe ist keine Erklärung und keine Einflussgröße.

## Bewertung

Überschätzen ist für mich nachteiliger als Unterschätzen. Das Verhältnis entspricht den Strompreisen an meinen beiden Zählern: 34 ct gegen 24 ct. Jede kWh zu viel zählt also mit 34, jede kWh zu wenig mit 24.

Damit ist die günstigste Prognose nicht die mittlere. Sie sollte in etwa 41 % der Fälle zu hoch liegen (24 / (24 + 34)). Ich bleibe trotzdem bei der mittleren Prognose.

Kennzahlen gegen die gemessene Erzeugung, möglichst nach Wetterlage getrennt:

- mittlerer Fehler (systematisch zu hoch oder zu niedrig?)
- mittlerer absoluter Fehler
- Über- und Unterschätzung getrennt, mit größtem Ausreißer
- gewichteter Fehler 34/24 in ct

## Auswertung

Gelesen wird die Prognose quasi kontinuierlich, nicht zu einer festen Uhrzeit. Deshalb werte ich die Live-Werte aus, so wie ein Trigger sie zu jeder Stunde sieht:

- „Rest heute“ um hh:20 gegen das, was ab da bis Tagesende wirklich erzeugt wird
- „morgen“ um hh:20 gegen den Ertrag des Folgetags
- wie stark die Werte springen und wann kein Wert da war

hh:20 liegt nach den Abrufen von ICON (:10) und VRM (:15). Jede Prognose gilt mit ihrem letzten Wert. Ausgewertet werden ICON, VRM und das Minimum aus beiden (verodert).

Damit der Vergleich fair ist:

1. Gleicher Zeitpunkt: ICON und VRM jeweils mit dem Wert, der zur selben Uhrzeit galt. Gezählt werden nur Zeitpunkte, an denen beide einen Wert haben.
2. Gleiches Ist: Summe aller acht Erzeuger aus der ioBroker-History. Das VRM-Ist (Pb+Pc+Pg) lag an den ersten drei Tagen 1,5–2 % darunter, das nehme ich nicht.
3. Genug verschiedene Tage, klar, bedeckt, wechselhaft. Erster Eindruck nach etwa einer Woche, aussagekräftig ab 2–3 Wochen. Die Wetterlage lese ich aus der tatsächlichen Strahlung (`ghi0`).

Die Snapshots um 22:00 und 06:00 aus den ioBroker-Skripten sind davon nur zwei feste Zeitpunkte. Ich nutze sie als Gegenprobe.

```
python3 auswertung.py      # Kennzahlen
python3 auswertung.py -v   # dazu jede Stunde einzeln
```

## Wann die Prognosen kommen

| | ICON | VRM |
|---|---|---|
| Quelle | DWD ICON-D2 über Open-Meteo | VRM-API von Victron |
| Neue Prognose | Lauf alle 3 h (00, 03 … 21 UTC), 48 h Reichweite, bei Open-Meteo ca. 1 h 25 min nach Laufstart | alle 2 h (gemessen) |
| Abruf in ioBroker | stündlich um :10, ab der Fassung vom 25.10. zusätzlich spätestens 5 min nach jedem neuen Lauf | alle 15 min |
| Werte ändern sich (gemessen 23./24.10.) | große Sprünge alle 3 h mit dem neuen Lauf, dazwischen kleine stündliche Änderungen | alle 2 h, bei uns um etwa 01:15, 03:15 … (Sommerzeit) |
| Umstellung auf den neuen Tag | alle Werte gemeinsam um 00:10 (erster Abruf nach Mitternacht): „heute“, „Rest heute“, 1 h und 3 h auf den neuen Tag, „morgen“ auf den Tag danach. Alles wird aus den aktuellen Open-Meteo-Daten neu gerechnet, nichts aus „morgen“ übernommen. Von 00:00 bis 00:10 zeigt „heute“ noch den Vortag, „Rest heute“ 0 und „morgen“ den neuen Tag. | alle Werte gemeinsam um 00:00 |
| „morgen“ nach dem Umspringen | Sommerzeit: um 00:10 leer, erst mit dem Lauf von 21 UTC da (gemessen 00:40). Winterzeit: um 00:10 da (gemessen 26.–30.10. jede Nacht). Um 00:40 ändert sich der Wert, weil der Lerntag dazukommt, gegen 02:25 kommt der Lauf von 00 UTC. | ab 00:00 |
| Snapshots | 22:00 (morgen), 06:00 (heute) | 22:00 (morgen), 06:00 (heute) |
| Tagesabschluss | 00:40 | 00:20 |
| Abruf schlägt fehl | Werte bleiben stehen, `forecast.error` gesetzt | Werte bleiben stehen, `forecast.error` gesetzt |

### Läufe und Abrufe bei ICON

- Der DWD rechnet ICON-D2 alle 3 h neu, Start um 00, 03 … 21 UTC. Jeder Lauf beginnt mit den neuesten Messdaten und reicht 48 h weit.
- Wo die Zeit bleibt, gemessen am Lauf 18 UTC vom 25.10. (Zeiten UTC):

  | Schritt | Uhrzeit | nach Laufstart |
  |---|---|---|
  | Laufstart | 18:00 | |
  | erste Datei beim DWD (+0 h) | 18:44 | 44 min |
  | letzte Datei beim DWD (+48 h) | 19:20:44 | 1 h 21 min |
  | bei Open-Meteo abrufbar | 19:24:16 | 1 h 24 min |
  | in ioBroker (Abruf um :10, alte Fassung) | 20:10 | 2 h 10 min |

  Die Rechenzeit beim DWD lässt sich nicht verkürzen. Open-Meteo kostet gut 3 Minuten. Die 46 min danach lagen am starren Abruf um :10.
- Ab der Fassung vom 25.10. ([iobroker/Pv_forecast_icon.js](iobroker/Pv_forecast_icon.js)) fragt das Skript alle 5 min bei Open-Meteo nach dem neuesten Lauf (`https://api.open-meteo.com/data/dwd_icon_d2/static/meta.json`) und holt ihn sofort. Dann sind es etwa 1 h 25–30 min nach Laufstart.
- Direkt beim DWD gäbe es die ersten Vorhersagestunden etwa 35 min früher, die für morgen aber nur wenige Minuten früher. Dafür müsste ich GRIB2 verarbeiten. Das lohnt sich nicht.
- Der stündliche Abruf um :10 bleibt: „Rest heute“, „nächste Stunde“ und „3 Stunden“ hängen an der Uhrzeit.
- Mit jedem neuen Lauf springen die Werte. Die Snapshots nehmen den Lauf, der gerade der neueste ist.
- Neue Läufe gibt es nur alle 3 h. Trotzdem ändern sich die Werte auch zwischen den Läufen. Woher das kommt, weiß ich noch nicht. Die neue Fassung schreibt je Abruf mit, aus welchem Lauf die Werte stammen (`forecast.run_init_ts`, `run_available_ts`, `run_modified_ts`). Daran sehe ich, ob sich Werte innerhalb eines Laufs ändern.

### Warum Open-Meteo

- Das Modell bleibt ICON-D2 vom DWD. Open-Meteo rechnet nicht selbst, es reicht die DWD-Daten weiter.
- Beim DWD liegen die Daten als GRIB2-Dateien je Lauf, Größe und Vorhersagestunde für ganz Mitteleuropa, die Strahlung gemittelt seit Laufstart. Ich müsste meinen Gitterpunkt herausschneiden und in Stundenwerte zurückrechnen. Open-Meteo liefert für meinen Standort gleich Stundenmittel als JSON. Das liest das ioBroker-Skript ohne Zusatzsoftware.
- Für das Lernen und den Backtest braucht das Skript, was einen Tag vorher vorhergesagt war. Das liefert die Previous-Runs-API von Open-Meteo (`shortwave_radiation_previous_day1`). Der DWD hält nur die letzten Läufe vor, etwa einen Tag. Ohne Open-Meteo bräuchte ich ein eigenes Archiv.
- Nachteil: ein Dienst mehr dazwischen. Fällt Open-Meteo aus, gibt es keinen ICON-Wert. Zeit kostet Open-Meteo kaum, gemessen gut 3 Minuten.

## Daten

ioBroker läuft auf der Kodi-Box. Alle Datenpunkte unter `0_userdata.0.`:

| Datenpunkt | Inhalt | Aufbewahrung |
|---|---|---|
| `pvForecast*.forecast.pv_*_kWh` | Live-Werte heute, Rest heute, 1 h, 3 h, morgen | History, 1 Jahr |
| PV-Quellen (acht Erzeuger) | Leistung | History, 183 Tage |
| `pvForecastIcon.compare.days_json` | Tagesvergleich der Snapshots, ICON und VRM gegen dasselbe Ist | 400 Tage |
| `pvForecastIcon.learn.days_json` | Ist, Strahlung vorhergesagt (`ghi`) und tatsächlich (`ghi0`) je Stunde | 60 Tage |
| `pvForecastIcon.snap.archive_json` | ICON-Snapshots je Stunde und Erzeuger | 10 Tage |
| `pvForecastVrm.snap.archive_json` | VRM-Snapshots je Stunde | 10 Tage |
| `pvForecastIcon.backtest.result_json` | ICON-Backtest ab 20.06.2026 | bis zum nächsten Lauf |
| `PV.PV_gesamt_P` | PV-Leistung gesamt, DC + AC | |

Die Snapshots je Stunde halten nur 10 Tage, nach der Umstellung 30. Ich hole die Daten von Hand ab, spätestens alle vier Wochen. Rechner: Entwicklungsrechner.

```
./fetch.sh                 # Datenpunkte und PV-Log -> data/raw/JJJJ-MM-TT_HHMM.txt
./fetch.sh hist 20261024   # History-Dateien eines Tages -> data/raw/hist/20261024.txt
./fetch.sh hist            # dasselbe für gestern
```

Ich werte nur abgeschlossene Tage aus. Die Datei des laufenden Tages war beim Abholen am 25.10. um 22:40 allerdings schon bis 22:30 gefüllt.

Die aktuelle Fassung des ICON-Skripts liegt in [iobroker/Pv_forecast_icon.js](iobroker/Pv_forecast_icon.js). Das VRM-Skript liegt nicht hier, es enthält den VRM-Token.

Der Schlüssel `~/.ssh/kodibox_pvexport` darf auf der Kodi-Box nur `~/bin/pv-export` starten. Das Skript gibt die Datenpunkte, die PV-Logzeilen und die History-Dateien der PV-Datenpunkte aus und schreibt nichts. Eine Kopie liegt in [kodibox/pv-export](kodibox/pv-export).

Zugang wieder entfernen (Rechner: Kodi-Box, Benutzer: kodibox):

```
sed -i '\#command="/home/kodibox/bin/pv-export"#d' ~/.ssh/authorized_keys
```

### Eigene Werte

Im Repo stehen statt meiner Werte Platzhalter:

| Datei | Platzhalter |
|---|---|
| [iobroker/Pv_forecast_icon.js](iobroker/Pv_forecast_icon.js) | `LAT`, `LON`: Standort |
| [iobroker/Wp_budget.js](iobroker/Wp_budget.js) | `<venus-id>`: Portal-ID von Venus OS, `<seriennummer>`: Wechselrichter an DTUoB_WP |
| [kodibox/pv-export](kodibox/pv-export) | `VENUS_ID`, `DTU_WP_SERIAL`: wie oben |

`klarheit.py` und `strahlung.py` lesen Standort und DWD-Station aus `lokal.json` im Projektordner. Die Datei ist nicht im Repo:

```
{"lat": 0.0, "lon": 0.0, "dwd_station": "00000"}
```

Die nächste Station mit Strahlungsmessung steht in der [Stationsliste des DWD](https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/solar/now/zehn_now_sd_Beschreibung_Stationen.txt).

Die Messdaten unter `data/` sind ebenfalls nicht im Repo. `fetch.sh`, `stunden.py`, `verbrauch.py` und `strahlung.py` legen sie dort an.

## Stand 13.11.2026: ICON gegen VRM

Live-Werte 22.10.–13.11., Stichprobe hh:20, nur Zeitpunkte, an denen beide einen Wert haben. „Rest heute“ für 22 Tage (23.10.–13.11.), „morgen“ für 22 Zieltage (23.10.–13.11.).

| | Anzahl | mittl. Fehler | mittl. abs. Fehler | größtes Zuviel | gewichtet je Abfrage |
|---|---|---|---|---|---|
| Rest heute, ICON | 363 | +2,36 kWh | 4,15 kWh | 20,40 kWh | 132 ct |
| Rest heute, VRM | 363 | +2,27 kWh | 4,64 kWh | 20,08 kWh | 146 ct |
| Rest heute, Minimum | 363 | +0,96 kWh | 3,81 kWh | 20,08 kWh | 115 ct |
| morgen, ICON | 503 | +1,69 kWh | 5,10 kWh | 16,63 kWh | 156 ct |
| morgen, VRM | 503 | +1,93 kWh | 5,69 kWh | 19,17 kWh | 175 ct |
| morgen, Minimum | 503 | +0,16 kWh | 4,93 kWh | 16,15 kWh | 144 ct |

Getrennt nach Zieltag, mittlerer Fehler und gewichtet je Abfrage:

| | bis 30.10. (8 Tage) | ab 31.10. (14 Tage) |
|---|---|---|
| Rest heute, ICON | −0,58 kWh, 58 ct | +4,05 kWh, 175 ct |
| Rest heute, VRM | +1,78 kWh, 145 ct | +2,55 kWh, 147 ct |
| Rest heute, Minimum | −1,25 kWh, 70 ct | +2,23 kWh, 142 ct |
| morgen, ICON | −2,76 kWh, 114 ct | +3,91 kWh, 178 ct |
| morgen, VRM | −0,18 kWh, 163 ct | +2,98 kWh, 180 ct |
| morgen, Minimum | −3,43 kWh, 124 ct | +1,95 kWh, 154 ct |

Tage, an denen eine Prognose gewichtet günstiger war:

| | bis 30.10. | ab 31.10. |
|---|---|---|
| Rest heute | ICON 6, VRM 2 | ICON 1 (08.11.), VRM 13 |
| morgen | ICON 4, VRM 4 | ICON 6, VRM 8 |

- Über alle Tage liegt ICON vorn, gewichtet 10 % (Rest heute) und 11 % (morgen) günstiger. Das Minimum ist in beiden am günstigsten.
- Seit 31.10. hat sich das gedreht. Bei „Rest heute“ war VRM an 13 von 14 Tagen günstiger. ICON lag im November fast jeden Tag zu hoch, im Mittel +4,05 kWh. Bis 30.10. lag ICON im Mittel leicht zu niedrig. Ursache: siehe unten, „Warum ICON seit 31.10. zu hoch liegt“.
- Bei „morgen“ liegen beide seit 31.10. gleichauf (178 zu 180 ct).
- Den 03.11. haben beide verfehlt: „Rest heute“ im Mittel gut 18 kWh zu hoch, gekommen sind 4,16 kWh. „Morgen“ für den 03.11., 04.11. und 06.11. lag bei beiden 13–16 kWh zu hoch.
- ICON hatte seit 23.10. zu jeder Stichprobe einen Wert, außer um 00:20 in der Sommerzeit (23.–25.10., bekannt). Am 22.10. lief ICON noch nicht. VRM hatte immer einen Wert.
- Ist 06.11.: `PV_Garage_P` 10:14–11:53 ohne neuen Wert, davon 68 min als Lücke gezählt (Tag 2,67 kWh).
- Die Datei vom 28.10. hatte ich am 28.10. um 07:54 geholt, sie endete um 07:53. Am 13.11. neu geholt: 18,72 kWh statt 0,35.
- Den 13.11. habe ich am selben Tag um 22:24 geholt. Die PV ist vollständig, die Prognosewerte ab 22:24 fehlen. Beim nächsten Abholen neu holen: `./fetch.sh hist 20261113`.

### Warum ICON seit 31.10. zu hoch liegt

Die Prognose ist Faktor je Stunde × vorhergesagte Strahlung. Zu hoch kann also die Strahlung sein oder der Faktor. Um das zu trennen, brauche ich die tatsächliche Strahlung. `ghi0` (jüngster ICON-Lauf) taugt dafür nicht, das ist auch nur eine Vorhersage. Ich nehme deshalb die Messung der nächsten DWD-Station mit Strahlungsmessung (Globalstrahlung in 10 min, DWD Open Data). Die Zeitstempel sind UTC. Geprüft am Schwerpunkt klarer Tage: Er liegt innerhalb von ±0,3 h bei dem von ICON.

An den drei schwachen Tagen hatte ICON die Strahlung viel zu hoch, auch im jüngsten Lauf. Die Module haben, gemessen an der echten Strahlung, normal umgesetzt (sonst meist 8–12 kWh je kWh/m²):

| Tag | Ist | gemessen | ICON Vortag | ICON jüngster Lauf | Ist je gemessener kWh/m² |
|---|---|---|---|---|---|
| 03.11. | 4,24 kWh | 0,47 kWh/m² | 1,39 (×3,0) | 0,99 (×2,1) | 9,0 |
| 04.11. | 2,46 kWh | 0,43 kWh/m² | 1,85 (×4,3) | 0,89 (×2,1) | 5,8 |
| 06.11. | 2,96 kWh | 0,32 kWh/m² | 0,98 (×3,1) | 0,98 (×3,1) | 9,2 |

Zerlegung der Day-Ahead-Prognose, Faktoren wie im Skript (7 letzte gültige Lerntage):
Fehler = [Prognose mit ICON-Vortag − Prognose mit Messung] (Strahlung) + [Prognose mit Messung − Ist] (Umrechnung).

| Zieltage | Fehler Ø | davon Strahlung | davon Umrechnung | abs. Ø Strahlung | abs. Ø Umrechnung |
|---|---|---|---|---|---|
| 23.10.–30.10. (8) | −2,63 kWh | −2,18 kWh | −0,45 kWh | 2,92 kWh | 2,34 kWh |
| 31.10.–12.11. (13) | +3,23 kWh | +3,36 kWh | −0,13 kWh | 5,13 kWh | 3,19 kWh |

- Seit 31.10. liegt ICON zu hoch, weil die vorhergesagte Strahlung zu hoch war. Am meisten am 03.11. (+11,4 kWh), 04.11. (+16,1), 05.11. (+7,5) und 06.11. (+7,9). Die Umrechnung stimmt im Mittel.
- Die Umrechnung streut aber von Tag zu Tag. Am 08.11. lag sie −12,1 kWh daneben: 16,1 kWh je gemessener kWh/m², so viel wie an keinem anderen Tag seit 10.10.
- Meine erste Zerlegung mit `ghi0` statt der Messung hat den Fehler fälschlich dem Faktor zugeschrieben (+2,28 kWh Umrechnung seit 31.10.).
- Die Plausibilitätsprüfung im ICON-Skript rechnet ebenfalls mit `ghi0`. Sie hat den 04.11. als „Ertrag unplausibel niedrig (Datenausfall?)“ verworfen. Die History ist an dem Tag vollständig (1 min Lücke).
- Die Station steht nicht bei mir. An einzelnen Tagen kann das Wetter dort anders sein.

```
python3 strahlung.py                          # Stationsdaten holen -> data/stunden/dwd_stunden.json, beide Tabellen
python3 strahlung.py 2026-10-31 2026-11-12    # Zerlegung nur für diese Tage
```

Die Lerntage liest das Skript aus dem neuesten `data/raw/JJJJ-MM-TT_HHMM.txt`, vorher also `./fetch.sh`.

## Stand 30.10.2026: Verbrauch

Geplant: Jede kWh, die ICON für morgen über (Verbrauch + Puffer) vorhersagt, bekommt die Wärmepumpe.

Verbrauch laut Venus (`alias.0.VenusOS.AC_Consumption_P`, Eingang und Ausgang des MP2, ohne Wärmepumpe): 30.09.–29.10. im Mittel 16,7 kWh je Tag, 11,7–22,1 kWh. Die Werte vom 01.–22.08. sind nicht plausibel, ich lasse sie weg. Seit 30.10. in `pv-export`, Tageswerte mit `python3 verbrauch.py` -> `data/stunden/verbrauch_stunden.json`.

Puffer geprüft an 30.09.–27.10. (26 Tage), Tagesbilanz Ertrag − Verbrauch, ICON-Vortagesprognose nachgerechnet:

| Puffer | Schwelle | Wärmepumpe bekommt Ø | zu viel vergeben | ungenutzt Ø | gewichtet 34/24 |
|---|---|---|---|---|---|
| 0 kWh | 16,7 kWh | 7,2 kWh/Tag | an 8 Tagen | 2,0 kWh/Tag | 66 ct/Tag |
| 1 kWh | 17,7 kWh | 6,5 kWh/Tag | an 6 Tagen | 2,4 kWh/Tag | 65 ct/Tag |
| 2 kWh | 18,7 kWh | 5,9 kWh/Tag | an 2 Tagen | 2,8 kWh/Tag | 71 ct/Tag |
| 3 kWh | 19,7 kWh | 5,2 kWh/Tag | an 1 Tag | 3,4 kWh/Tag | 82 ct/Tag |

Entscheidung: 2 kWh Puffer, Schwelle = Mittel der letzten 14 Tage + 2 kWh (Oktober: 17,7–18,9 kWh). 14 statt 28 Tage, damit etwas Dynamik bleibt. Geprüft an 67 Tagen (10.07.–29.10.), wie gut das Mittel der letzten N Tage den Verbrauch des Folgetags trifft: 7 Tage 2,73 kWh mittlerer Fehler, 14 Tage 2,67, 21 Tage 2,68, 28 Tage 2,63. Die Fenstergröße macht wenig aus, der Verbrauch schwankt von Tag zu Tag stärker. 28 Tage hält die Schwelle ruhig (Oktober 17,9–18,7 kWh, mit 7 Tagen 17,3–19,4) und enthält jeden Wochentag viermal. Ob die Batterie den Überschuss bis zur Wärmepumpe halten kann, steckt in der Tagesbilanz nicht drin.

### Plan Wärmepumpen-Budget

Die Wärmepumpe zieht abends und nachts. Was sie in der Nacht vor einem Tag aus der Batterie nimmt, füllt die PV dieses Tages wieder auf. Deshalb zählt die Prognose für morgen.

Der Tagesdurchschnitt sagt, wie viel übrig ist, aber nicht, ob es heute Nacht schon in der Batterie liegt. Vom Hausverbrauch (ohne Wärmepumpe) fällt ein großer Teil nachts an: im Oktober ab 16 Uhr bis die PV morgens reicht im Median 9,8 kWh von 16,7 kWh am Tag, also etwa 60 %.

Die Regel gilt rund um die Uhr. Ein Budget gilt von Abend zu Abend: Was DTUoB_WP in der Nacht vor dem Zieltag und am Zieltag selbst abgibt, zählt gegen dessen Budget.

Jede Minute: Rest = kleinerer Wert aus
- Budget = PV-Ertrag des Zieltags bis jetzt + ICON-Prognose für den Rest des Zieltags − (Verbrauch Ø 14 Tage + 2 kWh) − seit dem Abend abgegeben. Vor Mitternacht gibt es noch kein Ist, dann zählt die volle Prognose für morgen. Am Zieltag ersetzt das Ist die vergangenen Stunden: Kommt weniger als vorhergesagt, schrumpft das Budget mit. Beispiel 31.10. um 14:13: 21,55 kWh Ist + 2,39 kWh Rest − 19,2 = 4,7 kWh statt 6,5 nach der Tagesprognose.
- Zukunft = so viel, dass die Batterie bis zum Morgen nach der nächsten Nacht nie unter 20 % plus Puffer fällt. Das Skript rechnet die Batterie Stunde für Stunde voraus: + ICON-PV (heute und morgen) − Hausverbrauch (Ø je Stunde, 14 Tage), höchstens voll. Der Puffer wächst mit 2 kWh je 24 h. Ist morgen trüb, füllt die PV die Batterie nicht wieder auf, und die Zukunft schrumpft schon heute Nacht. Ist morgen sonnig, darf die Batterie tiefer gehen, weil morgen wieder geladen wird.
- Kein festes SOC-Ziel. Die Regel „tagsüber erst 100 %“ ist raus (31.10.): Vor sonnigen Tagen ist sie zu streng, denn was morgen früh übrig ist, verdrängt morgen PV ins Netz. Vor trüben Tagen verlangt die Vorausrechnung von selbst eine volle Batterie. In der Simulation (30.10. nachmittags, morgen 28 kWh vorhergesagt) gab „erst 100 %“ um 13–16 Uhr −0,5 bis 1,0 kWh frei, die Vorausrechnung 6,0–7,8 kWh. Fiel die Prognose um 23:25 auf 8 kWh, ging die Freigabe sofort auf 0.

Fehlen Werte, ist die Stützung aus.

Die Vorausrechnung läuft jede Minute mit dem aktuellen SOC und der neuesten Prognose. Stützung aus, sobald Rest ≤ 0. Wieder an erst, wenn Rest ≥ 1 % SOC (0,22 kWh). Das ist die Hysterese, ein SOC-Schritt allein schaltet nicht.

Abend: PV < Hausverbrauch für 15 min, frühestens Sonnenuntergang − 2 h, spätestens Sonnenuntergang. Morgen: PV > Hausverbrauch für 15 min, frühestens Sonnenaufgang, spätestens Sonnenaufgang + 4 h. PV live = `DC_PV_total_P` + `AC_MP2_PVonGrid_P`, in der Nachtstatistik die acht Erzeuger aus den Lerntagen. Hausverbrauch = `AC_Consumption_P` ohne Wärmepumpe. Die Wärmepumpe kann den Abend also nicht selbst auslösen. Die Nachtstatistik nutzt dieselben Regeln je Stunde.

Beispiel am Abend: Prognose morgen 28 kWh, Ø 16,7 kWh, SOC 100 %. Budget 28 − 18,7 = 9,3 kWh. Batterie 17,6 kWh nutzbar minus Reserve (9,8 + 1,3) kWh = 6,5 kWh. Rest 6,5 kWh. Bei SOC 50 % abends: 6,6 − 11,1 < 0, also keine Stützung, obwohl morgen die Sonne scheint.

Warum die Nacht so viel braucht, Oktober im Mittel je Stunde: 17–23 Uhr 6,8 kWh (Spitze 18–19 Uhr mit 1,6 kWh), 23–07 Uhr 2,1 kWh (etwa 260 W), 07–09 Uhr 1,5 kWh bei 0,7 kWh PV. Abend- und Morgenspitze liegen außerhalb der PV.

Wie oft es neue Werte gibt: ICON rechnet alle 3 h neu, abrufbar etwa 1 h 25 min nach Laufstart, abends und nachts (MEZ) gegen 17:25, 20:25, 23:25 und 02:25. Die Prognose für morgen gibt es jede Nacht ab 00:10. Das ICON-Skript holt jeden neuen Lauf spätestens 5 min danach und zusätzlich stündlich um :10. SOC, Verbrauch und DTUoB_WP kommen laufend über MQTT. Tagesdurchschnitt und Nachtprofil werden jeden Morgen neu gerechnet. Steigt die Prognose, steigt das Budget, und die Stützung geht wieder an, sobald Rest ≥ 0,22 kWh.

Umsetzung: [iobroker/Wp_budget.js](iobroker/Wp_budget.js), Datenpunkte unter `0_userdata.0.wpBudget.*`, schreibt je Zyklus Budget, abgegebene Energie (nachts und tagsüber), Schaltungen und SOC abends, morgens und am Ende mit (`naechte_json`). Ein Probelauf ist nicht nötig, Budget und Nachtbedarf sind an der History geprüft.

#### Datenpunkte, die das Skript liest und sendet

| Datenpunkt | Inhalt | Einheit / Werte | History |
|---|---|---|---|
| `0_userdata.0.pvForecastIcon.forecast.pv_hourly_json` | ICON-Prognose je Stunde für heute und morgen, `[Stundenbeginn ts_ms, kWh]`. Ändert er sich (neuer Lauf), rechnet das Skript sofort neu. | kWh je Stunde | nein |
| `0_userdata.0.pvForecastIcon.learn.days_json` | Lerntage des ICON-Skripts, daraus die PV je Stunde für das Nachtprofil | kWh je Stunde | nein |
| `alias.0.VenusOS.AC_Consumption_P` | Hausverbrauch laut Venus, Eingang und Ausgang des MP2, ohne Wärmepumpe. Live für Abend und Morgen, aus der History für Ø Verbrauch und Nachtprofil. | W | ja |
| `alias.0.VenusOS.DC_PV_total_P` | PV aller MPPT (DC), live | W | ja |
| `alias.0.VenusOS.AC_MP2_PVonGrid_P` | PV-Wechselrichter am Netz (Growatt und HMS), live | W | ja |
| `mqtt.1.N.<venus-id>.battery.291.Soc` | Ladezustand der Batterie. Venus liefert Text `{"value":31.6}`. | % | ja |
| `mqtt.0.DTUoB_WP.powerlimiter.status.mode` | Modus des Dynamic Power Limiter von DTUoB_WP | 0 = normal, Stützung nach Bedarf. 1 = aus, Wechselrichter abgeschaltet. 2 = volle Solar-Durchreichung, nicht genutzt | ja, seit 31.10. |
| `mqtt.0.DTUoB_WP.<seriennummer>.0.yieldtotal` | Gesamtzähler der Energie, die DTUoB_WP abgegeben hat. Abgegeben = Stand jetzt − Stand am Zyklusbeginn. | kWh | ja, seit 31.10. |
| Topic `DTUoB_WP/powerlimiter/cmd/mode` | Befehl an den Power Limiter, gesendet über `sendTo('mqtt.0', 'sendMessage2Client', {…, retain: false})` | 0 / 1, ohne retain | – |
| `system.adapter.mqtt.0` | Version des mqtt-Adapters; erst ab 5 wird `retain: false` übernommen | – | – |

Nur für die Auswertung in `pv-export`, vom Skript nicht gelesen: `mqtt.0.DTUoB_WP.<seriennummer>.0.powerdc` (DC-Leistung aus der Batterie, W), `mqtt.0.DTUoB_WP.powermeter.powertotal` (Leistung am Zähler, dem der Power Limiter folgt, W) und `mqtt.0.DTUoB_WP.powermeter.import` (Bezugszähler an dieser Stelle, Wh).

Geprüft an der History: Der Zuwachs von `import` passt zum Integral der positiven `powertotal`-Werte, am 30.10. 6852 Wh gegen 6,84 kWh, am 31.10. bis 14:19 Uhr 4982 Wh gegen 4,98 kWh. Der Zähler zeigt nur, was nach der Stützung noch aus dem Netz kommt: Bei `powerdc` über 1500 W lag `powertotal` am 30.10. im Median bei 270 W, Minimum −843 W im ganzen Tag. Einen eigenen Datenpunkt für den Verbrauch der Wärmepumpe habe ich nicht. Er ergibt sich aus Zuwachs `import` + Zuwachs `yieldtotal` − Einspeisung am Zähler (30.10.: 0,01 kWh), sofern hinter dem Zähler nur die Wärmepumpe hängt. Beispiel 30.10.: 6,85 kWh Bezug + höchstens 3,47 kWh von DTUoB_WP (DC-Integral, `yieldtotal` lag an dem Tag noch nicht in der History), also höchstens 10,3 kWh.

`mqtt.0.DTUoB_WP.ac.yieldday` zählt in Wh die Abgabe von DTUoB_WP, ohne den Netzbezug. Er ist derzeit kein Tageswert: Am 02.11. um 20:17 Uhr stand er auf 4289 und `yieldtotal` auf 1620,74. Das ist genau der Zuwachs von `yieldtotal` seit dem Stand 1616,451: 2,229 kWh am 31.10., 0,405 kWh am 01.11., 1,655 kWh am 02.11. In den Nächten zum 01.11. und 02.11. wurde er also nicht zurückgesetzt, auch nicht durch die Moduswechsel des Power Limiter. Die letzte Rücksetzung war vor dem 31.10. 09:28 Uhr, als `yieldtotal` zum ersten Mal über 1616,451 stieg; wann genau, sehe ich nicht. Tageswerte rechne ich deshalb aus `yieldtotal`. In `pv-export` ist `ac.yieldday` nicht enthalten.

Verbrauch der Wärmepumpe je Tag, Zuwachs `import` + Zuwachs `yieldtotal`: 31.10. 6,86 + 2,23 = 9,09 kWh, 01.11. 10,94 + 0,41 = 11,35 kWh, 02.11. bis etwa 20:10 Uhr 7,45 + 1,66 = 9,10 kWh. Einspeisung am Zähler ist nicht abgezogen. Das DC-Integral liegt deutlich über der Abgabe (31.10. 3,47 zu 2,23 kWh, 01.11. 1,45 zu 0,41 kWh, 02.11. 2,37 zu 1,66 kWh), die Ursache habe ich nicht geprüft. Die Obergrenze für den 30.10. ist also großzügig.

#### Datenpunkte, die das Skript schreibt (`0_userdata.0.wpBudget.*`)

| Datenpunkt | Inhalt | Einheit | History |
|---|---|---|---|
| `phase` | `Nacht` vom Abend bis zum Morgen, sonst `Tag` | – | nein |
| `zieltag` | Tag, gegen dessen Budget gezählt wird | JJJJ-MM-TT | nein |
| `prognose_kWh` | ICON-Prognose für den ganzen Zieltag, neuester Lauf (nur zur Anzeige) | kWh | ja |
| `verbrauch_avg_kWh` | Hausverbrauch Ø der letzten 14 vollständigen Tage, jeden Morgen neu | kWh | ja |
| `nacht_avg_kWh` | Nachtbedarf des Hauses aus der Batterie, Ø der letzten 14 Nächte | kWh | ja |
| `nacht_stunden` | Nachtlänge Ø (Abend bis Morgen) | h | nein |
| `nacht_profil_json` | `{R[25], H[25], C[24]}`: Nachtstatistik je Stunde ab 12 Uhr und Hausverbrauch Ø je Stunde (C, für die Vorausrechnung) | kWh, h | nein |
| `pv_ist_kWh` | PV-Ertrag heute seit Mitternacht (beim Start aus der History von `DC_PV_total_P` + `AC_MP2_PVonGrid_P`, dann jede Minute aufsummiert) | kWh | ja |
| `erwartet_kWh` | Zieltag erwartet: PV Ist bis jetzt + ICON-Rest (vor Mitternacht: volle Prognose) | kWh | ja |
| `budget_kWh` | erwartet − (Verbrauch Ø + 2 kWh), mindestens 0 | kWh | ja |
| `freigabe_kWh` | **so viel darf die Wärmepumpe jetzt noch bekommen**: kleinster Wert aller Grenzen, mindestens 0 | kWh | ja |
| `zukunft_kWh` | Ergebnis der Vorausrechnung bis zum Morgen nach der nächsten Nacht | kWh | ja |
| `engpass` | knappste Stelle der Vorausrechnung ohne Wärmepumpe (Wochentag, Uhrzeit, kWh über 20 % + Puffer) | – | nein |
| `reserve_kWh` | was in der Batterie bleiben muss: Batterie über 20 % − Zukunft | kWh | ja |
| `pv_rest_kWh` | ICON-Prognose für den Rest von heute, wie `pvForecastIcon.forecast.pv_remaining_today_kWh`, aber jede Minute neu gerechnet | kWh | ja |
| `batterie_kWh` | Batterie-Seite, gleich `zukunft_kWh` | kWh | ja |
| `rest_kWh` | wie Freigabe, aber auch negativ (wie weit die Grenze überschritten ist); leer, wenn Werte fehlen | kWh | ja |
| `abgegeben_kWh` | Energie von DTUoB_WP seit Zyklusbeginn (Abend) | kWh | ja |
| `stuetzung` | gewünschter Zustand: `true` = Modus 0, `false` = Modus 1 | – | ja |
| `naechte_json` | Zyklen Abend bis Abend (letzte 60): Zieltag, Uhrzeiten Abend/Morgen/Ende, SOC dazu, Prognose, Budget, abgegeben nachts und gesamt, Schaltungen | – | nein |
| `fehler` | Fehlertext, leer = OK | – | nein |

- DTUoB ist OpenDTU-OnBattery (WP: Hostname OpenDTU-WP-…, Konfiguration 0.1.30-OnBattery-8, Firmware 2026.07.23). Stützung an/aus = Modus des Dynamic Power Limiter: Topic `DTUoB_WP/powerlimiter/cmd/mode`, 0 = normal (Stützung nach Bedarf), 1 = aus (Wechselrichter abgeschaltet). Status in `mqtt.0.DTUoB_WP.powerlimiter.status.mode`. Abgegebene Energie: `mqtt.0.DTUoB_WP.<seriennummer>.0.yieldtotal` (kWh).
- Im DPL-Status stehen SOC-Schwellen 77/55 %. Sie sind nicht aktiv, das Skript berücksichtigt sie nicht. Meine erste Fassung hatte sie als aktiv angenommen und tagsüber nicht eingegriffen; das lief am Ziel vorbei, weil die Wärmepumpe tagsüber ohne Grenze ziehen konnte.
- Befehle ohne retain: Retained Befehle legen OpenDTU-OnBattery lahm ([Issue #1629](https://github.com/hoylabs/OpenDTU-OnBattery/issues/1629)). Das Skript sendet über `sendTo('mqtt.0', 'sendMessage2Client', {…, retain: false})`. Der mqtt-Adapter übernimmt `retain` daraus erst ab Version 5 (Quellcode geprüft: 4.0.7 nicht, 5.2.0 bis 9.0.2 ja). Das Skript prüft die Version beim Start und schaltet sonst nicht.
- Der Modus überlebt keinen Neustart der DTU, danach steht er auf 0. Das Skript prüft ihn jede Minute und setzt ihn höchstens alle 2 min neu.
- Nachtprofil im Skript (Tage 16.–29.10. im Test): Ø Nachtbedarf 10,7 kWh. Ø Verbrauch 17,5 kWh.
- Simulation Minute für Minute vom 30.10. 12:00 bis 31.10. 22:00 (Oktober-Profil, SOC in 1-%-Schritten, DPL ohne eigene Schwellen; Wärmepumpe 1,5 kW 18–20 Uhr, 0,6 kW 22–06 Uhr, 0,8 kW 11–13 Uhr, 1,5 kW 15–16 Uhr):

  | Prognose für den 31.10. | nachts abgegeben | tagsüber am Zieltag | Budget | tiefster SOC |
  |---|---|---|---|---|
  | 28 → 31 kWh | 7,6 kWh | 3,1 kWh (tagsüber nur Budget) | 11 kWh, genutzt 10,7 | 25 % |
  | 21 → 24 kWh | 4,3 kWh | 0 (Budget nachts aufgebraucht) | 4,3 kWh | 40 % |

  Nie bei 20 %, kein Flattern. Getestet auch mit SOC als JSON-Text und `getAstroDate` aus einem anderen Kontext wie in der ioBroker-Sandbox.
- Fassung mit Vorausrechnung eingespielt am 31.10. um 14:59. Erster Stand: SOC 79,5 %, PV heute 21,94 kWh, Zukunft 1,78 kWh frei, knappste Stelle Mo. 02.11. 09:06 (Morgen nach der zweiten Nacht), Stützung an.
- Eingespielt am 31.10. um 00:25. Erste Nacht (Zieltag 31.10.): Prognose 23,3 kWh, Budget 4,1 kWh, SOC 36,9 %, Reserve 3,7 kWh, also Batterie −0,02 kWh und Stützung aus. Befehl 00:25:25, DPL-Modus 1 ab 00:25:29 (`lc` des Status), also nach 4 s.
- `mqtt.0` läuft als Broker (`desc: mqtt server variable`). History für `powerlimiter.status.mode` und `0.yieldtotal` seit 31.10. 00:2x aktiv.
- Venus-Werte über `mqtt.1` sind JSON-Text (`{"value":31.6}`), das Skript liest daraus die Zahl.

## Stand 28.10.2026: zu niedrig an klaren Tagen?

Mein Verdacht nach dem 27.10.: ICON war am oberen Anschlag, der Wert stand den ganzen Vormittag. Dann läge die Prognose an klaren Tagen generell zu niedrig.

Geprüft mit 102 Tagen (11.07.–27.10.). Die Prognose habe ich wie im ICON-Skript nachgerechnet: Stundenfaktoren aus den 7 letzten gültigen Tagen, Strahlung vom Vortag. Im Mittel liegt sie −0,69 kWh je Tag daneben, der Backtest im Skript kommt auf −0,71. Klarheit heißt hier: ICON-Vortagesstrahlung geteilt durch die Strahlung bei wolkenlosem Himmel (Haurwitz). Der 27.10. hatte 0,95, das Maximum im ganzen Zeitraum war 0,97. ICON war also wirklich am Anschlag.

| vorhergesagte Klarheit | Tage | Ist Ø | Fehler Ø | zu niedrig | gewichtet je Tag |
|---|---|---|---|---|---|
| ≥ 0,9 | 22 | 41,9 kWh | +0,92 kWh (+2,2 %) | 10 von 22 | 96 ct |
| 0,8–0,9 | 26 | 37,9 kWh | +1,65 kWh (+4,4 %) | 6 von 26 | 85 ct |
| 0,6–0,8 | 29 | 35,5 kWh | −2,13 kWh (−6,0 %) | 20 von 29 | 96 ct |
| 0,4–0,6 | 14 | 25,2 kWh | −3,37 kWh (−13,4 %) | 9 von 14 | 155 ct |
| < 0,4 | 11 | 11,8 kWh | −2,25 kWh (−19,1 %) | 9 von 11 | 89 ct |

Je Monat, mittlerer Fehler (Anzahl Tage):

| Monat | ≥ 0,9 | 0,8–0,9 | 0,6–0,8 | < 0,6 |
|---|---|---|---|---|
| Juli | +4,5 % (6) | +1,5 % (4) | −6,0 % (9) | −22,9 % (2) |
| August | +4,3 % (6) | +6,4 % (7) | −8,7 % (8) | −21,2 % (4) |
| September | +1,3 % (8) | +3,9 % (10) | +7,7 % (5) | −25,5 % (6) |
| Oktober | −12,0 % (2) | +5,1 % (5) | −11,9 % (7) | +3,4 % (13) |

- Am Anschlag liegt die Prognose im Mittel leicht zu hoch, nicht zu niedrig. Zu niedrig war sie an 10 von 22 Tagen.
- Zu niedrig liegt sie vor allem, wenn ICON Wolken vorhersagt (Klarheit unter 0,8). Dann kam meist mehr als erwartet. Im Oktober gilt das bei den trüben Tagen nicht.
- Die beiden klaren Oktobertage lagen beide zu niedrig: 22.10. −8 %, 27.10. −16 %. Der nötige Faktor an klaren Tagen stieg im Oktober schnell: 9,7 am 06.10., 11,0 am 22.10., 12,0 am 27.10. Das Lernfenster von 7 Tagen hinkt dem hinterher. Ob das im Herbst an klaren Tagen regelmäßig so ist, sagen zwei Tage nicht.
- Dass der Wert am 27.10. den ganzen Vormittag stand, heißt nur: Alle ICON-Läufe sahen keine Wolken. Über die Umrechnung sagt das nichts.
- Ich ändere nichts. Mit mehr klaren Herbsttagen rechne ich das wieder nach.

```
python3 stunden.py 2026-10-28 2026-11-20   # weitere Tage holen und verdichten -> data/stunden/ist_stunden.json
python3 klarheit.py                        # Tabellen oben
python3 klarheit.py -v                     # dazu die Oktobertage einzeln
```

Die ICON-Strahlung dafür liegt in `data/stunden/icon_d2_*.json` (Open-Meteo Previous Runs, `timeformat=unixtime`). Für neue Tage muss ich sie dazuholen.

## Stand 27.10.2026: klarer Tag, ICON zu niedrig

- Am 27.10. kamen 32,95 kWh. ICON sagte am Vorabend 25,5 kWh für morgen voraus, morgens durchgehend 27,5 kWh für den Rest des Tages. Das sind gut 20 % zu wenig.
- Die Strahlung hatte ICON richtig. Vortagesprognose und jüngster Lauf liegen stündlich innerhalb von 1–2 %: 2,74 kWh/m², davon 76 % direkt.
- Zu niedrig war die Umrechnung in kWh. Das Lernfenster 20.–26.10. ergibt 9,9 kWh je kWh/m², erreicht wurden 12,0. In der Woche war nur der 22.10. klar.
- Der Fehlbetrag lag am Vormittag. 7–12 Uhr kamen 17,9 statt 13,1 kWh (Morgen-Snapshot), ab 12 Uhr 15,0 statt 14,4.
- Klare Tage lagen je kWh/m² Anfang Oktober bei 9,2–10,0, am 14.–16.10. bei 11,3–11,6, am 22.10. bei 11,2 und am 27.10. bei 12,0. Trübe Tage streuen von 5 bis 13, weil ICON Wolken und Nebel oft nicht trifft.

Rückwirkend gerechnet über 08.–27.10. (20 Tage), Prognose mit der Strahlung vom Vortag wie live, Fehler je Tag in kWh:

| Umrechnung | mittl. abs. Fehler | mittl. Fehler | gewichtet je Tag | 27.10. |
|---|---|---|---|---|
| jetzt: Faktor je Stunde, 7 Tage | 2,75 | −0,36 | 78 ct | −5,2 |
| Faktor je UTC-Stunde (Zeitumstellung) | 2,79 | −0,40 | 79 ct | −5,8 |
| ein Faktor je Tag, 7 Tage | 2,68 | −0,41 | 76 ct | −5,8 |
| ein Faktor je Tag, 14 Tage | 2,69 | −0,65 | 75 ct | −4,0 |
| geneigte Ebene (angepasst: 10°, Ost), Faktor je Tag | 2,81 | −0,45 | 79 ct | −5,9 |
| Direkt und Diffus getrennt, 7 Tage | 3,45 | −0,38 | 98 ct | −5,3 |
| Direkt und Diffus getrennt, 14 Tage | 3,06 | −0,74 | 85 ct | −4,4 |
| Faktor aus den 3 ähnlichsten Tagen (Direktanteil) von 14 | 2,98 | −1,04 | 81 ct | −4,7 |

- Keine Variante ist besser als die jetzige. Direkt und Diffus getrennt ist deutlich schlechter.
- An den 8 klaren Tagen (Direktanteil ≥ 45 %) liegt die jetzige Umrechnung im Mittel bei −0,07 kWh. Systematisch zu niedrig ist sie an klaren Tagen also bisher nicht. Der 26.10. (−5,0) und der 27.10. (−5,8) sind es beide.
- „Rest heute“ mit dem Ist vom Vormittag hochzurechnen hätte am 27.10. geschadet. Um 12:20 wären es 18,4 statt 13,5 kWh gewesen, gekommen sind 13,1.
- Ich ändere die Umrechnung nicht. Mit mehr klaren Tagen bei tiefer Sonne rechne ich das wieder nach.

## Stand 25.10.2026

### Live-Werte, stündlich

| | Anzahl | mittl. Fehler | mittl. abs. Fehler | größtes Zuviel | gewichtet je Abfrage |
|---|---|---|---|---|---|
| Rest heute, ICON | 51 | +1,58 kWh | 1,58 kWh | 4,65 kWh | 54 ct |
| Rest heute, VRM | 51 | +6,71 kWh | 6,76 kWh | 15,44 kWh | 230 ct |
| Rest heute, Minimum | 51 | +1,44 kWh | 1,50 kWh | 4,65 kWh | 51 ct |
| morgen, ICON | 48 | +2,29 kWh | 2,36 kWh | 6,38 kWh | 80 ct |
| morgen, VRM | 48 | +7,69 kWh | 7,69 kWh | 15,22 kWh | 262 ct |
| morgen, Minimum | 48 | +1,98 kWh | 2,05 kWh | 4,97 kWh | 69 ct |

- Rest heute: 23. bis 25.10., gezählt solange noch mindestens 0,5 kWh zu erwarten waren. Morgen: abgegeben am 22.10. (ab 22:20), 23.10. und 24.10. für den jeweiligen Folgetag.
- Am 25.10. kamen 5,20 kWh. ICON sagte den ganzen Tag 5,5–7,2 kWh für heute voraus, VRM 15,7–20,6 kWh.
- Beide lagen fast immer zu hoch. Drei Tage tragen kein Urteil.
- Mein Ist liegt 0,05–0,2 kWh je Tag unter dem des ICON-Skripts. Am 24.10. erklärt das die 6-min-Lücke (ich zähle sie als 0, das Skript hält den Wert davor), am 23.10. noch nicht. Am 25.10. fehlen um 09:35 ebenfalls rund 6 min bei allen Quellen.
- Die ICON-Werte bis 24.10. 22:38 stammen aus älteren Skriptversionen.

### Snapshots (Gegenprobe)

Tagessumme in kWh gegen das History-Ist:

| Tag | Ist | ICON Day-Ahead | VRM Day-Ahead | ICON Morgen | VRM Morgen |
|---|---|---|---|---|---|
| 23.10. | 13,56 | 12,89 (−5,0 %) | 21,64 (+59,5 %) | 17,29 (+27,4 %) | 24,91 (+83,6 %) |
| 24.10. | 19,47 | 21,25 (+9,1 %) | 20,87 (+7,2 %) | 20,59 (+5,7 %) | 22,40 (+15,0 %) |
| 25.10. | 5,20* | 5,71 (+9,8 %) | 16,30 (+213 %) | 6,02 (+15,8 %) | 20,20 (+288 %) |

\* mein Ist aus der History; der Tagesabschluss des Skripts läuft um 00:40.

- Den 22.10. lasse ich weg. ICON lief noch nicht. Der VRM-Morgenwert kam erst um 22:21 ins Archiv, wann er erstellt wurde, ist nicht gespeichert.
- VRM-Abrufe am 21.10. um 20:02 und am 22.10. um 15:58 mit HTTP 401 (Token ungültig).
- ICON-Backtest 20.06.–21.10. (96 Tage, Day-Ahead): Tagesfehler 3,6 kWh (10,4 %), im Mittel 0,7 kWh zu niedrig. Mit der tatsächlichen statt der vorhergesagten Strahlung sind es noch 8,2 %. Die größten Ausreißer liegen meist zu niedrig (bis −66 %), zweimal deutlich zu hoch (+102 % am 24.09., +82 % am 01.10.).

## Offen

- [x] History-Dateien der Live-Werte und der acht Quellen in `pv-export` aufgenommen (25.10.), 22.–24.10. abgeholt.
- [x] Erste Auswertung der Live-Werte (`auswertung.py`).
- [ ] Auswertung erweitern: nach Wetterlage, nach Tageszeit, Sprünge, Zeiten ohne Wert.
- [x] Prüfen, warum ICON seit 31.10. fast jeden Tag zu hoch liegt: Strahlung zu hoch vorhergesagt, Umrechnung im Mittel richtig (Stand 13.11., gemessen an der nächsten DWD-Station).
- [ ] Rückwirkend rechnen, ob Faktoren gegen die gemessene Strahlung der DWD-Station besser sind als gegen die ICON-Vortagesstrahlung. Ebenso die Plausibilitätsprüfung gegen die Messung statt gegen `ghi0`.
- [ ] Klären, warum VRM seit 31.10. bei „Rest heute“ fast jeden Tag günstiger ist. An 03.11., 04.11. und 06.11. lagen beide etwa gleich daneben.
- [ ] `./fetch.sh hist 20261113` neu holen (am selben Tag geholt, Prognosewerte ab 22:24 fehlen).
- [ ] Ist-Abweichung zum ICON-Skript am 23.10. klären.
- [x] ICON-Skript in der Fassung vom 25.10. eingespielt (25.10. 22:42; Laufzeit je Abruf, Abruf bei neuem Lauf, Archiv 30 Tage).
- [ ] Mit `forecast.run_*_ts` klären, woher die Änderungen zwischen den Läufen kommen.
- [ ] Lücken je Quelle prüfen. Die Tagesprüfung im ICON-Skript erkennt nur, wenn alle Quellen gleichzeitig schweigen. Am 25.10. gab es abends Verbindungsabbrüche, u. a. mqtt.1 zu Venus OS.
- [ ] Die Netzwerkkarte der Kodi-Box (r8169) hing am 25.10. abends mehrfach („transmit queue timed out“). Abruffehler in solchen Zeiten treffen beide Prognosen und zählen bei der Verfügbarkeit nicht gegen VRM oder ICON.
- [ ] Growatt-Alias `alias.0.GroWatt_WR.OutputPower`: „Invalid read function“ (JSON.parse) am 25.10. 17:38–17:44. Prüfen, ob das auch tagsüber vorkommt und was history dann speichert.
- [ ] `ARCHIVE_DAYS` im VRM-Skript von 10 auf 30 (im ICON-Skript in der Fassung vom 25.10. enthalten).
- [x] Kein automatisches Abholen, der Entwicklungsrechner läuft nicht dauernd. Die Daten vom 22.–25.10. sind gesichert.
- [ ] Für Trigger auf ertragsschwache Tage: Schwelle festlegen, dann je Variante (ICON, Minimum) verpasste schwache Tage und unnötige Auslösungen zählen.
- [ ] Liste der Modulflächen (Azimut, Neigung, kWp), falls ich pro Fläche rechne.
- [ ] Später: ICON mit Direkt- und Diffusstrahlung getrennt statt nur Globalstrahlung. Am 27.10. rückwirkend geprüft (08.–27.10.): schlechter als jetzt, siehe Stand 27.10.
- [x] Open-Meteo rechnet mit `timezone=Europe/Berlin` die ganze Antwort mit einem festen Versatz um, dem zum Abrufzeitpunkt. Liegt eine Zeitumstellung im abgerufenen Zeitraum, sind die Stunden auf der anderen Seite um eine Stunde verschoben. Betroffen ist der Backtest am 01.11. (20.06.–31.10., Sommertage eine Stunde daneben) und die Live-Prognose an den Tagen um die Umstellung. Die Lerntage nicht, sie werden einzeln am Folgetag geholt. Behoben in der Fassung vom 27.10. ([iobroker/Pv_forecast_icon.js](iobroker/Pv_forecast_icon.js)): `timeformat=unixtime`. Getestet am 27.10. mit den Skriptfunktionen in Node (TZ=Europe/Berlin), Abruf 01.–27.10. gegen die gespeicherten Lerntage: alte Fassung 299 von 598 Stunden abweichend (alle 24 Sommerzeit-Tage), neue 0. Live-Prognose alt und neu gleich. Eingespielt am 28.10. um 07:58, Start ohne Fehler, Faktoren unverändert.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
