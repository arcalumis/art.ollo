#!/usr/bin/env bash
#
# Back up ollo.art: the SQLite database AND the image volumes.
#
# The database holds users, the credit ledger, subscriptions and payments. The
# image volumes hold every generation and reference upload. Neither has any
# other copy, and losing either half breaks the product: a DB without images
# restores to broken thumbnails, images without the DB restore to nobody's art.
#
#   15 * * * * /home/baud/art.ollo/scripts/backup.sh hourly >> /home/baud/backups/ollo/backup.log 2>&1
#   50 3 * * * /home/baud/art.ollo/scripts/backup.sh daily  >> /home/baud/backups/ollo/backup.log 2>&1
#   10 5 * * 0 /home/baud/art.ollo/scripts/backup.sh weekly >> /home/baud/backups/ollo/backup.log 2>&1
#
# Pattern copied from bible.oceanhai/scripts/backup.sh — see that file for the
# reasoning behind the append-only mirror loop and the temp-then-promote dance.
set -euo pipefail

# cron's PATH lacks /usr/local/bin, where rclone lives.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

KIND="${1:-daily}"
CONTAINER="${CONTAINER:-artollo-app-1}"
IMAGES_VOLUME="${IMAGES_VOLUME:-ollo_art_images}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-ollo_art_uploads}"

# Outside the repo, so `git clean -xfd` can never reach it.
DIR="${BACKUP_DIR:-/home/baud/backups/ollo}"
MIN_DB_BYTES="${MIN_DB_BYTES:-100000}"

case "$KIND" in
  hourly) KEEP="${KEEP:-48}"; STAMP="$(date +%Y-%m-%dT%H)" ;;
  daily)  KEEP="${KEEP:-14}"; STAMP="$(date +%Y-%m-%d)" ;;
  weekly) KEEP="${KEEP:-9}";  STAMP="$(date +%Y-%m-%d)" ;;
  *) echo "usage: $(basename "$0") [hourly|daily|weekly]" >&2; exit 2 ;;
esac

log()  { echo "$(date -Is) [$KIND] $*"; }
fail() {
  log "FAILED: $*"
  /usr/local/bin/notify-mercury --to telegram:Castle \
    "ollo.art backup [$KIND] FAILED: $*" || true
  exit 1
}
warn() {
  log "WARNING: $*"
  /usr/local/bin/notify-mercury --to telegram:Castle \
    "ollo.art backup [$KIND]: $*" || true
}

mkdir -p "$DIR"

# ── 1. Image mirrors (every tier, append-only) ──────────────────────────────
# Generated images and uploads are named by UUID and never rewritten, so an
# append-only copy is safe, and a trash purge in the app cannot propagate here.
mirror_volume() {
  local volume="$1" dst="$2"
  mkdir -p "$dst"
  docker volume inspect "$volume" >/dev/null 2>&1 \
    || fail "docker volume $volume does not exist"

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$volume":/src:ro \
    -v "$dst":/dst \
    alpine:3 sh -c 'cd /src && find . -type f -exec sh -c '"'"'
        for f do
          [ -e "/dst/$f" ] && continue
          mkdir -p "$(dirname "/dst/$f")" || exit 1
          cp "$f" "/dst/$f" || exit 1
        done
      '"'"' sh {} +' \
    || fail "mirror copy of $volume failed"

  local live mirrored
  live="$(docker run --rm -v "$volume":/src:ro alpine:3 sh -c 'find /src -type f | wc -l' | tr -d '[:space:]')"
  mirrored="$(find "$dst" -type f | wc -l)"
  [ "$mirrored" -ge "$live" ] \
    || fail "$volume mirror holds $mirrored files but the volume has $live"
  log "mirror $volume: $mirrored files (live $live)"
}
mirror_volume "$IMAGES_VOLUME" "$DIR/images-mirror"
mirror_volume "$UPLOADS_VOLUME" "$DIR/uploads-mirror"

# ── 2. Database snapshot (every tier) ───────────────────────────────────────
# VACUUM INTO writes a consistent, WAL-merged copy while the app keeps running.
# Copying generations.db directly would miss whatever is still in the -wal file.
DB_OUT="$DIR/ollo-db-$KIND-$STAMP.db.gz"
DB_TMP="$DIR/.ollo-db-$KIND-$STAMP.db.tmp"
IN_CONTAINER="/tmp/ollo-backup-$$.db"
trap 'rm -f "$DB_TMP" "$DB_TMP.gz"; docker exec "$CONTAINER" rm -f "$IN_CONTAINER" >/dev/null 2>&1 || true' EXIT

docker exec "$CONTAINER" bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('/app/data/generations.db', { readonly: true });
  db.exec(\"VACUUM INTO '$IN_CONTAINER'\");
" || fail "VACUUM INTO inside $CONTAINER failed"
docker cp "$CONTAINER:$IN_CONTAINER" "$DB_TMP" >/dev/null || fail "docker cp of snapshot failed"
docker exec "$CONTAINER" rm -f "$IN_CONTAINER"

DB_SIZE="$(stat -c %s "$DB_TMP")"
[ "$DB_SIZE" -ge "$MIN_DB_BYTES" ] \
  || fail "snapshot is only ${DB_SIZE}B (floor ${MIN_DB_BYTES}B) — refusing to promote it"
[ "$(sqlite3 "$DB_TMP" 'PRAGMA integrity_check;')" = "ok" ] \
  || fail "snapshot fails PRAGMA integrity_check"
USERS="$(sqlite3 "$DB_TMP" 'SELECT COUNT(*) FROM users;')"
[ "${USERS:-0}" -ge 1 ] || fail "snapshot has no users — refusing to promote it"

gzip -9 "$DB_TMP"
mv "$DB_TMP.gz" "$DB_OUT"
trap - EXIT
log "wrote $DB_OUT ($(du -h "$DB_OUT" | cut -f1), $USERS users)"

# ── 3. Retention ────────────────────────────────────────────────────────────
find "$DIR" -maxdepth 1 -name "ollo-db-$KIND-*.db.gz" -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | while read -r old; do
  rm -f "$old" && log "pruned $old" || log "WARNING: could not prune $old"
done

# ── 4. Off-host copy (non-fatal, not silent) ────────────────────────────────
if [ -r /home/baud/vanir.video/.env ]; then
  set +e
  (
    set -a; . /home/baud/vanir.video/.env; set +a
    export RCLONE_CONFIG_B2_TYPE=s3
    export RCLONE_CONFIG_B2_PROVIDER=Other
    export RCLONE_CONFIG_B2_ACCESS_KEY_ID="$B2_ACCESS_KEY_ID"
    export RCLONE_CONFIG_B2_SECRET_ACCESS_KEY="$B2_SECRET_ACCESS_KEY"
    export RCLONE_CONFIG_B2_ENDPOINT="$B2_ENDPOINT"
    export RCLONE_CONFIG_B2_REGION="$B2_REGION"

    rclone copyto "$DB_OUT" "B2:$B2_BUCKET/ollo/db/$(basename "$DB_OUT")" \
      --s3-no-check-bucket --retries 3 || exit 1
    rclone copy "$DIR/images-mirror" "B2:$B2_BUCKET/ollo/images" \
      --s3-no-check-bucket --retries 3 --transfers 8 || exit 1
    rclone copy "$DIR/uploads-mirror" "B2:$B2_BUCKET/ollo/uploads" \
      --s3-no-check-bucket --retries 3 --transfers 8 || exit 1
  ) >/dev/null 2>&1
  b2_rc=$?
  set -e
  if [ "$b2_rc" -ne 0 ]; then
    warn "B2 off-host copy failed (rc=$b2_rc); local copies are fine"
  else
    log "copied off-host to B2"
  fi
else
  log "WARNING: no B2 credentials readable; local copies only"
fi

log "ok"
