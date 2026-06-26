#!/bin/bash
# Daily backup of .env files and compose configs.
# Cron: 0 3 * * * /home/altsay/bots/helyx/scripts/backup-configs.sh

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/altsay/backups/configs}"
KEEP_DAYS=14
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"
echo "[backup-configs] Starting at $(date)"

OUT="$BACKUP_DIR/configs_${TIMESTAMP}.tar.gz"

tar -czf "$OUT" \
  /home/altsay/bots/helyx/.env \
  /home/altsay/bots/carlson-bot/.env \
  /home/altsay/actions-runner/.env \
  /home/altsay/bots/helyx/dashboard/.env \
  /home/altsay/bots/helyx/docker-compose.yml \
  /home/altsay/bots/carlson-bot/compose.yaml \
  2>/dev/null || true

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup-configs] OK: configs_${TIMESTAMP}.tar.gz ($SIZE)"

# Rotate — keep last N backups
ls -t "${BACKUP_DIR}/configs_"*.tar.gz 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs -r rm -f

REMAINING=$(ls "${BACKUP_DIR}/configs_"*.tar.gz 2>/dev/null | wc -l)
echo "[backup-configs] Done. $REMAINING backups retained."
