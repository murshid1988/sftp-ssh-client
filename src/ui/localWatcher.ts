import * as vscode from 'vscode';
import { ConnectionConfig } from '../connections/connectionConfig';
import { ConnectionsTreeProvider } from './connectionsTreeProvider';
import { SyncDecorationProvider } from './syncDecorationProvider';
import { SyncManifestStore } from '../sync/syncManifest';

/**
 * Watches every connection's local folder — regardless of Sync Mode — purely
 * to keep the sidebar tree and Explorer decorations honest. This is separate
 * from AutoSyncManager's watcher, which only exists for "auto" connections
 * and triggers uploads; this one never uploads anything, it just refreshes
 * the UI (including on delete, which AutoSyncManager's watcher ignores).
 */
export class LocalChangeWatcher {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly treeProvider: ConnectionsTreeProvider,
    private readonly decorationProvider: SyncDecorationProvider,
    private readonly manifestStore: SyncManifestStore,
  ) {}

  sync(connections: ConnectionConfig[]): void {
    const activeIds = new Set(connections.map((c) => c.id));
    for (const [id, watcher] of this.watchers) {
      if (!activeIds.has(id)) {
        watcher.dispose();
        this.watchers.delete(id);
      }
    }

    for (const conn of connections) {
      if (!conn.localPath || this.watchers.has(conn.id)) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(conn.localPath, '**/*'));
      const onEvent = () => this.scheduleRefresh(conn.id);
      watcher.onDidChange(onEvent);
      watcher.onDidCreate(onEvent);
      // A deletion means we can no longer vouch for any folder being "fully
      // downloaded" — a full download afterwards will re-mark it. Changes and
      // new files don't invalidate that claim (a file being modified is still
      // present), only removal does.
      watcher.onDidDelete(() => {
        this.manifestStore.clearFullyDownloadedFolders(conn.id).then(() => this.scheduleRefresh(conn.id));
      });
      this.watchers.set(conn.id, watcher);
    }
  }

  // Scoped per connection so editing a file in one connection's local folder
  // doesn't force every OTHER connection's expanded folders to refetch too.
  private scheduleRefresh(connectionId: string): void {
    const existing = this.debounceTimers.get(connectionId);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      connectionId,
      setTimeout(() => {
        this.treeProvider.refreshConnection(connectionId);
        this.decorationProvider.refreshAll();
      }, 300),
    );
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}
