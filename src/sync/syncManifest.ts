import * as vscode from 'vscode';

export interface StatEntry {
  size: number;
  mtimeMs: number;
}

/**
 * The state we last knew both sides to be in for a file. Local and remote
 * clocks are different machines, so we track them separately rather than
 * assuming one timestamp works for comparing against both — comparing a
 * server's mtime against a local write time would almost always look like a
 * "conflict" even when nothing actually changed.
 */
export interface ManifestEntry {
  local: StatEntry;
  remote: StatEntry;
}

export type Manifest = Record<string, ManifestEntry>;

function storageKey(connectionId: string): string {
  return `sftpSsh.manifest.${connectionId}`;
}

function syncedFoldersKey(connectionId: string): string {
  return `sftpSsh.syncedFolders.${connectionId}`;
}

type LegacyManifest = Record<string, StatEntry | ManifestEntry>;

function isLegacyEntry(entry: StatEntry | ManifestEntry): entry is StatEntry {
  return typeof (entry as StatEntry).size === 'number' && !('local' in entry);
}

export class SyncManifestStore {
  constructor(private readonly globalState: vscode.Memento) {}

  get(connectionId: string): Manifest {
    const raw = this.globalState.get<LegacyManifest>(storageKey(connectionId), {});
    let needsMigration = false;
    const manifest: Manifest = {};
    for (const [relativePath, entry] of Object.entries(raw)) {
      if (isLegacyEntry(entry)) {
        // Entries saved before local/remote tracking was split. We can't
        // recover the true separate values, so treat the recorded stat as
        // the best-known baseline for both sides — this stops it from being
        // silently read as "nothing changed" forever, which was masking real
        // edits from both auto-sync and the sidebar's pending indicator.
        manifest[relativePath] = { local: entry, remote: entry };
        needsMigration = true;
      } else {
        manifest[relativePath] = entry;
      }
    }
    if (needsMigration) {
      void this.set(connectionId, manifest);
    }
    return manifest;
  }

  async set(connectionId: string, manifest: Manifest): Promise<void> {
    await this.globalState.update(storageKey(connectionId), manifest);
  }

  /** Folder paths (relative to the connection's remote root, '' = root) known to be fully downloaded. */
  getFullyDownloadedFolders(connectionId: string): Set<string> {
    return new Set(this.globalState.get<string[]>(syncedFoldersKey(connectionId), []));
  }

  async markFolderFullyDownloaded(connectionId: string, relativeFolderPath: string): Promise<void> {
    const folders = this.getFullyDownloadedFolders(connectionId);
    folders.add(relativeFolderPath);
    await this.globalState.update(syncedFoldersKey(connectionId), [...folders]);
  }

  /** Called whenever local files change outside our control — we can no longer vouch for "fully downloaded". */
  async clearFullyDownloadedFolders(connectionId: string): Promise<void> {
    await this.globalState.update(syncedFoldersKey(connectionId), []);
  }
}
