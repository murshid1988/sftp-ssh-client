# Changelog

## 0.1.2

- Add a Ko-fi support link to the README.

## 0.1.1

- Add a branded hero image and README screenshots.

## 0.1.0 — Initial release

- Connection management via a form-based **Manage Connections** panel — no manual JSON editing.
- SSH/SFTP support for password, private key, SSH agent, and `~/.ssh/config`-based authentication.
- Dedicated **SFTP/SSH** sidebar: browse the remote filesystem, see download/upload status per file and folder, connect/disconnect, and run per-item transfers.
- Manual sync (**Download Workspace**, **Sync Now**) and per-connection **auto-sync** (upload as soon as you save a file).
- Conflict detection before overwriting either side, with the option to overwrite, skip, or pull the latest remote version instead.
- Explorer integration: sync-status decorations (in sync / needs upload / syncing) and right-click **Upload**/**Download** actions on any file or folder.
- Status bar indicator for background sync activity, plus a quick command menu (including an "Open Log" shortcut).
- **Mark as Synced (No Transfer)** to re-establish tracking without re-downloading, for cases like changing a connection's Remote Path.
