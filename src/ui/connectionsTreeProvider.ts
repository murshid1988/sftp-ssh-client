import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig, getConnections, findConnectionForLocalPath } from '../connections/connectionConfig';
import { ConnectionManager } from '../connections/connectionManager';
import { AutoSyncManager } from '../sync/autoSyncWatcher';
import { Manifest, SyncManifestStore } from '../sync/syncManifest';
import { SyncingTracker } from '../sync/syncingTracker';
import { countPendingUploads } from '../sync/pendingChanges';
import { hasUnexpectedChange } from '../sync/conflictDetector';
import { joinRemote, readdir } from '../ssh/sftpService';

export type SyncStatus = 'full' | 'partial' | 'modified' | 'none';

export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    connected: boolean,
    autoSyncActive: boolean,
    pendingCount: number,
  ) {
    super(connection.id || connection.host, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `conn:${connection.id}`;
    const pendingSuffix = pendingCount > 0 ? ` · ${pendingCount} pending` : '';
    this.description = `${connection.username}@${connection.host}${autoSyncActive ? ' · auto-sync' : ''}${pendingSuffix}`;
    this.tooltip =
      `${connection.authType} auth · ${connection.remotePath} → ${connection.localPath}` +
      (pendingCount > 0 ? `\n${pendingCount} file(s) changed locally since the last sync` : '');
    this.contextValue = connected ? 'sftpConnectionConnected' : 'sftpConnectionDisconnected';
    this.iconPath = new vscode.ThemeIcon(
      connected ? 'vm-active' : 'vm-outline',
      pendingCount > 0
        ? new vscode.ThemeColor('list.warningForeground')
        : connected
          ? new vscode.ThemeColor('charts.green')
          : undefined,
    );
  }
}

export class RemoteEntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    public readonly remotePath: string,
    public readonly relativePath: string,
    public readonly isDirectory: boolean,
    syncStatus: SyncStatus,
    syncing: boolean,
  ) {
    super(
      path.posix.basename(remotePath),
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `conn:${connection.id}:path:${remotePath}`;
    // File context values carry sync status (e.g. "remoteFile-modified") so
    // the "Upload This Item" button can be shown only where it's actionable.
    this.contextValue = isDirectory ? 'remoteDir' : `remoteFile-${syncStatus}`;

    const statusLabel = isDirectory
      ? syncStatus === 'full'
        ? 'all downloaded'
        : syncStatus === 'partial'
          ? 'partially downloaded'
          : undefined
      : syncStatus === 'full'
        ? 'downloaded'
        : syncStatus === 'modified'
          ? 'needs upload'
          : undefined;
    this.description = syncing ? 'syncing…' : statusLabel;

    if (syncing) {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (isDirectory) {
      this.iconPath = new vscode.ThemeIcon(
        syncStatus === 'full' ? 'folder-active' : 'folder',
        syncStatus === 'full'
          ? new vscode.ThemeColor('charts.green')
          : syncStatus === 'partial'
            ? new vscode.ThemeColor('charts.yellow')
            : undefined,
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        'file',
        syncStatus === 'full'
          ? new vscode.ThemeColor('charts.green')
          : syncStatus === 'modified'
            ? new vscode.ThemeColor('list.warningForeground')
            : undefined,
      );
    }

    this.tooltip =
      syncStatus === 'full'
        ? `${remotePath}\n(${isDirectory ? 'everything inside is downloaded' : 'downloaded to local folder'})`
        : syncStatus === 'partial'
          ? `${remotePath}\n(some files inside are downloaded)`
          : syncStatus === 'modified'
            ? `${remotePath}\n(changed locally — not yet uploaded)`
            : remotePath;
  }
}

type Node = ConnectionTreeItem | RemoteEntryTreeItem;

function folderHasSyncedDescendant(manifest: Manifest, localPath: string, relativePath: string): boolean {
  const prefix = relativePath === '' ? '' : `${relativePath}/`;
  return Object.keys(manifest).some((k) => k.startsWith(prefix) && fs.existsSync(path.join(localPath, k)));
}

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly autoSyncManager: AutoSyncManager,
    private readonly manifestStore: SyncManifestStore,
    private readonly syncingTracker: SyncingTracker,
  ) {
    this.connectionManager.onDidChangeConnectionState(() => this.refresh());
    // Syncing fires per-file, sometimes dozens of times in quick succession —
    // debounce so a big sync doesn't trigger a full local directory rescan
    // (for the pending-changes count) on every single file. Scoped to the
    // connection that file belongs to, not the whole tree.
    this.syncingTracker.onDidChange((localPath) => {
      const conn = findConnectionForLocalPath(localPath);
      this.scheduleRefresh(conn?.id);
    });
  }

  private refreshDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleRefresh(connectionId?: string): void {
    const key = connectionId ?? '*';
    const existing = this.refreshDebounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.refreshDebounceTimers.set(
      key,
      setTimeout(() => (connectionId ? this.refreshConnection(connectionId) : this.refresh()), 400),
    );
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /**
   * Invalidates only one connection's subtree instead of every expanded
   * folder across every connection — used for local file-change events,
   * which only ever affect a single connection's local folder.
   */
  refreshConnection(connectionId: string): void {
    const conn = getConnections().find((c) => c.id === connectionId);
    if (!conn) {
      this.refresh();
      return;
    }
    this.emitter.fire(
      new ConnectionTreeItem(
        conn,
        this.connectionManager.isConnected(conn.id),
        this.autoSyncManager.isActive(conn.id),
        countPendingUploads(conn, this.manifestStore),
      ),
    );
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      return getConnections().map(
        (c) =>
          new ConnectionTreeItem(
            c,
            this.connectionManager.isConnected(c.id),
            this.autoSyncManager.isActive(c.id),
            countPendingUploads(c, this.manifestStore),
          ),
      );
    }

    if (element instanceof ConnectionTreeItem) {
      return this.listRemoteDir(element.connection, element.connection.remotePath);
    }

    if (element instanceof RemoteEntryTreeItem && element.contextValue === 'remoteDir') {
      return this.listRemoteDir(element.connection, element.remotePath);
    }

    return [];
  }

  private async listRemoteDir(conn: ConnectionConfig, dirPath: string): Promise<Node[]> {
    try {
      const sftp = await this.connectionManager.getSftp(conn);
      const entries = await readdir(sftp, dirPath);
      const manifest = this.manifestStore.get(conn.id);
      const fullyDownloadedFolders = this.manifestStore.getFullyDownloadedFolders(conn.id);

      return entries
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .sort((a, b) => {
          const aDir = (a.attrs.mode & 0o170000) === 0o040000;
          const bDir = (b.attrs.mode & 0o170000) === 0o040000;
          if (aDir !== bDir) {
            return aDir ? -1 : 1;
          }
          return a.filename.localeCompare(b.filename);
        })
        .map((e) => {
          const fullPath = joinRemote(dirPath, e.filename);
          const relativePath = path.posix.relative(conn.remotePath, fullPath);
          const isDirectory = (e.attrs.mode & 0o170000) === 0o040000;
          const localFilePath = path.join(conn.localPath, relativePath);

          let syncStatus: SyncStatus;
          if (isDirectory) {
            if (fullyDownloadedFolders.has(relativePath)) {
              syncStatus = 'full';
            } else if (folderHasSyncedDescendant(manifest, conn.localPath, relativePath)) {
              syncStatus = 'partial';
            } else {
              syncStatus = 'none';
            }
          } else if (relativePath in manifest && fs.existsSync(localFilePath)) {
            // A file only counts as "downloaded" if it's both in the manifest
            // AND still exists locally — otherwise a deleted file keeps showing
            // as downloaded forever. If it exists but drifted from what we last
            // synced, it needs an upload, not another download.
            const stat = fs.statSync(localFilePath);
            const current = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000 };
            syncStatus = hasUnexpectedChange(manifest[relativePath]?.local, current) ? 'modified' : 'full';
          } else {
            syncStatus = 'none';
          }

          const syncing = !isDirectory && this.syncingTracker.isSyncing(localFilePath);
          return new RemoteEntryTreeItem(conn, fullPath, relativePath, isDirectory, syncStatus, syncing);
        });
    } catch (err) {
      vscode.window.showErrorMessage(`Could not list "${dirPath}": ${(err as Error).message}`);
      return [];
    }
  }
}
