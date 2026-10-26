#!/usr/bin/env bash
# sync-setup-rclone.sh — one-time setup to enable hourly auto-sync.
#
# The initial gallery clone was done through the Google Drive MCP (interactive
# Claude session only). Cron on this VPS cannot use that. To auto-detect NEW /
# renamed patterns hourly, configure ONE of the following, then enable the timer.
#
# ========================================================================
# OPTION A (RECOMMENDED) — rclone remote via a Google service account that is
# a MEMBER of the shared drive. Fully headless, no browser, no token refresh.
# ------------------------------------------------------------------------
#   1. In Google Cloud console, create (or reuse) a service account and a JSON
#      key. Enable the Drive API for its project.
#   2. In Google Drive, open the shared drive "2026 Crystal Patterns", click
#      Manage members, and add the service account's email
#      (xxxx@yyyy.iam.gserviceaccount.com) as at least a Viewer.
#   3. Put the JSON key on this VPS at:
#        /home/alexa/projects/fww-crystal-patterns/gdrive-sa.json   (chmod 600)
#      (or store it in Doppler as GDRIVE_PATTERNS_SA_KEY_B64 and have this
#       script materialise it — see below.)
#   4. Create the rclone remote:
#        rclone config create gdrive_patterns drive \
#          scope=drive.readonly \
#          service_account_file=/home/alexa/projects/fww-crystal-patterns/gdrive-sa.json \
#          team_drive=0AIEfu95vgNkWUk9PVA
#   5. Test:  rclone lsd gdrive_patterns: --drive-team-drive 0AIEfu95vgNkWUk9PVA
#   6. Enable: sudo systemctl enable --now fww-crystal-patterns-sync.timer
#
# NOTE: Doppler already holds GOOGLE_SEO_SA_EMAIL / GOOGLE_SEO_SA_KEY_B64.
# If that service account is added as a member of THIS shared drive (step 2),
# you can reuse it instead of making a new one:
#   doppler secrets get GOOGLE_SEO_SA_KEY_B64 --plain | base64 -d > gdrive-sa.json
#   chmod 600 gdrive-sa.json
#   (then step 4 onward). Verify its project has the Drive API enabled.
#
# ========================================================================
# OPTION B — reuse the existing interactive 'gdrive:' rclone remote, but widen
# its scope. The current 'gdrive:' remote uses scope=drive.file (app-created
# files only) so it CANNOT read this shared drive. Re-authorize it with
# scope=drive.readonly using an account that is a member of the shared drive:
#   rclone config reconnect gdrive:      # then choose full/read-only scope
# This requires a browser OAuth step (headed) once; the refresh token then
# works headlessly. Service account (Option A) is preferred — no token expiry.
# ========================================================================

set -e
echo "This is a documentation/helper script. Follow Option A (recommended)."
echo "After configuring the 'gdrive_patterns' remote, run:"
echo "  sudo systemctl enable --now fww-crystal-patterns-sync.timer"
echo "Verify with:  systemctl list-timers | grep crystal-patterns"
