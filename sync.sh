#!/usr/bin/env bash
# sync.sh — hourly re-sync for fww-crystal-patterns.
#
# Mirrors the WHOLE Google shared drive tree into public/patterns/<slug>/,
# auto-detecting NEW / renamed / changed files, then regenerates the gallery.
#
# REQUIRES a headless Drive credential the VPS can use from cron (the Google
# Drive MCP used for the initial clone is tied to an interactive Claude session
# and is NOT available here). See sync-setup-rclone.sh + README for the exact
# credential to provision. Until that credential exists this timer is DISABLED;
# enable it with:  systemctl enable --now fww-crystal-patterns-sync.timer
#
# Env:
#   RCLONE_REMOTE  (default: gdrive_patterns)  — rclone remote with drive.readonly
#                  scope, authorized to shared drive 0AIEfu95vgNkWUk9PVA.
set -uo pipefail
cd "$(dirname "$0")"

REMOTE="${RCLONE_REMOTE:-gdrive_patterns}"
DRIVE_ID="0AIEfu95vgNkWUk9PVA"
TS() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(TS)] sync start (remote=$REMOTE, drive=$DRIVE_ID)"

# slug -> top-level width folder id
declare -A MAP=(
  [half]="1MiTFc1ui1A08hc8lUlYDC9eFoiiSyETx"
  [five8]="1-3tQFRDHCi0rCc1UXns-NcC0SR5-wWa-"
  [one]="1-4GmiSZKZUwXrg3kC1a1W2Htl1RmOEqB"
  [onehalf]="1-58PetE9ZCpP6ljCNkvVZXbddlG9tVwg"
  [prong]="1-8xvEIHMG5NkKnNL79AgPfxYGxdOtcIF"
)

if ! command -v rclone >/dev/null 2>&1; then
  echo "[$(TS)] ERROR: rclone not installed. Skipping fetch; rebuilding from disk only."
elif ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE}:"; then
  echo "[$(TS)] ERROR: rclone remote '${REMOTE}:' not configured. See sync-setup-rclone.sh."
  echo "[$(TS)] Skipping fetch; rebuilding gallery from whatever is already on disk."
else
  # Verify the remote can actually see the shared drive before syncing.
  if ! rclone lsd "${REMOTE}:" --drive-team-drive "$DRIVE_ID" --drive-root-folder-id "$DRIVE_ID" >/dev/null 2>&1; then
    echo "[$(TS)] ERROR: remote '${REMOTE}:' cannot access shared drive $DRIVE_ID (scope/membership?). Skipping fetch."
  else
    for slug in "${!MAP[@]}"; do
      fid="${MAP[$slug]}"
      mkdir -p "sync_by_name/$slug"
      echo "[$(TS)] rclone sync $slug ($fid)"
      # Sync by human filename into a staging tree (mirrors renames/deletes).
      # DEPENDS: these folders are dedicated pattern-photo folders (confirmed
      # 2026-08-07 — every entry, extensioned or not, is image/jpeg content).
      # Many real pattern photos in this Drive have NO file extension in
      # their filename (e.g. "1.5\" Dynasty"), so an extension-based
      # --include list silently drops them. Filter by junk instead of by
      # extension so extensionless images still sync.
      rclone sync "${REMOTE}:" "sync_by_name/$slug" \
        --drive-team-drive "$DRIVE_ID" --drive-root-folder-id "$fid" \
        --fast-list --transfers 4 --checkers 8 \
        --exclude ".*" --exclude "Thumbs.db" --exclude "desktop.ini" \
        --exclude "*.txt" --exclude "*.zip" --exclude "*.doc" --exclude "*.docx" \
        --exclude "*.xls" --exclude "*.xlsx" \
        2>&1 | tail -3 || echo "[$(TS)] WARN: sync of $slug returned nonzero"
    done
    # build.js auto-detects sync_by_name/<slug>/ and indexes it directly,
    # so new/renamed files appear without a separate manifest rebuild.
  fi
fi

# Always regenerate the gallery from whatever is on disk.
node build.js
echo "[$(TS)] sync done"
