import * as vscode from 'vscode';
import { SFTPWrapper } from 'ssh2';
import { ConnectionConfig, getAutoSyncPollIntervalSeconds } from '../connections/connectionConfig';
import { SyncManifestStore } from './syncManifest';
import { uploadChanges } from './uploadChanges';
import { downloadWorkspace } from './downloadWorkspace';
import { SyncingTracker } from './syncingTracker';

interface WatcherHandle {
  fsWatcher: vscode.FileSystemWatcher;
  pollTimer: ReturnType<typeof setInterval>;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

export class AutoSyncManager {
  private readonly watchers = new Map<string, WatcherHandle>();

  constructor(
    private readonly manifestStore: SyncManifestStore,
    private readonly getSftp: (conn: ConnectionConfig) => Promise<SFTPWrapper>,
    private readonly log: (message: string) => void,
    private readonly syncingTracker: SyncingTracker,
    private readonly runExclusive: <T>(connectionId: string, operation: () => Promise<T>) => Promise<T>,
  ) {}

  isActive(connectionId: string): boolean {
    return this.watchers.has(connectionId);
  }

  start(conn: ConnectionConfig): void {
    if (this.watchers.has(conn.id)) {
      return;
    }

    const pattern = new vscode.RelativePattern(conn.localPath, '**/*');
    const fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handle: WatcherHandle = {
      fsWatcher,
      pollTimer: setInterval(() => {
        this.runDownload(conn).catch((err) => this.log(`Auto-sync download failed for ${conn.id}: ${err.message}`));
      }, getAutoSyncPollIntervalSeconds() * 1000),
    };

    const scheduleUpload = () => {
      if (handle.debounceTimer) {
        clearTimeout(handle.debounceTimer);
      }
      handle.debounceTimer = setTimeout(() => {
        this.runUpload(conn).catch((err) => this.log(`Auto-sync upload failed for ${conn.id}: ${err.message}`));
      }, 1000);
    };

    fsWatcher.onDidChange(scheduleUpload);
    fsWatcher.onDidCreate(scheduleUpload);

    this.watchers.set(conn.id, handle);
    this.log(`Auto-sync started for "${conn.id}".`);
  }

  stop(connectionId: string): void {
    const handle = this.watchers.get(connectionId);
    if (!handle) {
      return;
    }
    handle.fsWatcher.dispose();
    clearInterval(handle.pollTimer);
    if (handle.debounceTimer) {
      clearTimeout(handle.debounceTimer);
    }
    this.watchers.delete(connectionId);
    this.log(`Auto-sync stopped for "${connectionId}".`);
  }

  dispose(): void {
    for (const id of [...this.watchers.keys()]) {
      this.stop(id);
    }
  }

  private async runUpload(conn: ConnectionConfig): Promise<void> {
    await this.runExclusive(conn.id, async () => {
      const sftp = await this.getSftp(conn);
      const result = await uploadChanges(sftp, conn, this.manifestStore, this.syncingTracker);
      if (result.uploaded > 0 || result.downloadedInstead.length > 0 || result.skippedConflicts.length > 0) {
        this.log(
          `Auto-sync: "${conn.id}" — ${result.uploaded} uploaded, ` +
            `${result.downloadedInstead.length} pulled from server instead, ${result.skippedConflicts.length} skipped.`,
        );
      }
    });
  }

  private async runDownload(conn: ConnectionConfig): Promise<void> {
    await this.runExclusive(conn.id, async () => {
      const sftp = await this.getSftp(conn);
      const result = await downloadWorkspace(sftp, conn, this.manifestStore, this.syncingTracker);
      if (result.downloaded > 0) {
        this.log(`Auto-sync: downloaded ${result.downloaded} file(s) for "${conn.id}".`);
      }
    });
  }
}
