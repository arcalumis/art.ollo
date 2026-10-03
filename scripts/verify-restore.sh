#!/usr/bin/env bash
#
# Restore the newest ollo.art DB snapshot to a scratch file and prove it works
# together with the image mirror. A backup that has never been restored is a
# hypothesis.
#
#   40 5 * * 0 /home/baud/art.ollo/scripts/verify-restore.sh daily >> /home/baud/backups/ollo/backup.log 2>&1
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

DIR="${BACKUP_DIR:-/home/baud/backups/ollo}"
TIER="${1:-daily}"
WORK="$(mktemp -d /tmp/ollo-verify.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

fails=0
ok()  { echo "$(date -Is) [verify] PASS $*"; }
bad() { echo "$(date -Is) [verify] FAIL $*"; fails=$((fails + 1)); }

ARCHIVE="$(find "$DIR" -maxdepth 1 -name "ollo-db-$TIER-*.db.gz" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
[ -n "$ARCHIVE" ] || { echo "$(date -Is) [verify] FAIL no $TIER snapshot to verify"; exit 1; }
echo "$(date -Is) [verify] verifying $(basename "$ARCHIVE")"

gunzip -c "$ARCHIVE" > "$WORK/restore.db" || { echo "$(date -Is) [verify] FAIL snapshot will not decompress"; exit 1; }
q() { sqlite3 "$WORK/restore.db" "$1"; }

[ "$(q 'PRAGMA integrity_check;')" = "ok" ] && ok "integrity_check" || bad "integrity_check"

for t in users generations user_credits subscription_products user_subscriptions; do
  n="$(q "SELECT COUNT(*) FROM $t;" 2>/dev/null || echo err)"
  case "$n" in
    ''|*[!0-9]*) bad "$t did not return a count" ;;
    0)           bad "$t restored empty" ;;
    *)           ok "$t restored $n rows" ;;
  esac
done

# Cross-store check: every live (not purged) generation's image must exist in
# the mirror. image_path looks like /images/<uuid>.<ext>.
total=0; missing=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  total=$((total + 1))
  f="${p##*/}"
  [ -f "$DIR/images-mirror/$f" ] || {
    missing=$((missing + 1))
    [ "$missing" -le 5 ] && echo "    missing: $f" || true
  }
done < <(q "SELECT image_path FROM generations WHERE image_path IS NOT NULL AND deleted_at IS NULL;")

if [ "$total" -eq 0 ]; then
  bad "restored database references no images"
elif [ "$missing" -eq 0 ]; then
  ok "all $total referenced images are present in the mirror"
else
  bad "$missing of $total referenced images are missing from the mirror"
fi

if [ "$fails" -gt 0 ]; then
  echo "$(date -Is) [verify] $fails check(s) failed"
  /usr/local/bin/notify-mercury --to telegram:Castle \
    "ollo.art restore verification FAILED ($fails checks)" || true
  exit 1
fi
echo "$(date -Is) [verify] restore verified end to end"
