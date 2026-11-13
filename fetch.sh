#!/bin/sh
# PV-Daten von der Kodi-Box holen. Rechner: Entwicklungsrechner.
# Der Schlüssel darf auf der Kodi-Box nur ~/bin/pv-export starten (nur lesen).
#   ./fetch.sh                 Datenpunkte und PV-Logzeilen -> data/raw/JJJJ-MM-TT_HHMM.txt
#   ./fetch.sh hist JJJJMMTT   History-Dateien eines Tages  -> data/raw/hist/JJJJMMTT.txt
#   ./fetch.sh hist            dasselbe für gestern
set -eu
cd "$(dirname "$0")"

case "${1:-}" in
    "")
        remote=""
        out="data/raw/$(TZ=Europe/Berlin date +%Y-%m-%d_%H%M).txt" ;;
    hist)
        day="${2:-$(TZ=Europe/Berlin date -d yesterday +%Y%m%d)}"
        case "$day" in
            [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
            *) echo "Datum als JJJJMMTT angeben" >&2; exit 1 ;;
        esac
        remote="hist $day"
        out="data/raw/hist/$day.txt" ;;
    *)
        echo "Aufruf: ./fetch.sh [hist [JJJJMMTT]]" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$out")"
ssh -i "$HOME/.ssh/kodibox_pvexport" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o ConnectTimeout=5 -o BatchMode=yes -T kodibox@192.168.1.4 $remote > "$out.tmp"
grep -q '^### end$' "$out.tmp" || { echo "Export unvollständig: $out.tmp" >&2; exit 1; }
if [ -n "$remote" ] && ! grep -q '^### hist ' "$out.tmp"; then
    echo "Keine History-Dateien im Export (pv-export auf der Kodi-Box zu alt?): $out.tmp" >&2
    exit 1
fi
mv "$out.tmp" "$out"
echo "$out ($(wc -c < "$out") Bytes)"
