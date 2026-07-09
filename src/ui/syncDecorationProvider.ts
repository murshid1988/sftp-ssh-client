import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConnections } from '../connections/connectionConfig';
import { SyncManifestStore } from '../sync/syncManifest';
import { SyncingTracker } from '../sync/syncingTracker';

function isInside(parentDir: string, candidate: string): boolean {
  const rel = path.relative(parentDir, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Decorates files under a connection's local folder in the VS Code Explorer,
 * mirroring what Git's built-in decorations do for M/U badges:
 *  - a spinning icon while the file is actively transferring
 *  - "↑" when the local copy has changed since the last sync (needs upload)
 *  - "↓" when the file matches what was last downloaded/uploaded (in sync)
 * Files never synced through this extension get no decoration at all.
 */
export class SyncDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(
    private readonly manifestStore: SyncManifestStore,
    private readonly tracker: SyncingTracker,
  ) {
    this.tracker.onDidChange((localPath) => this.emitter.fire(vscode.Uri.file(localPath)));
  }

  refreshAll(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.tracker.isSyncing(uri.fsPath)) {
      return {
        badge: '~',
        tooltip: 'Syncing…',
        color: new vscode.ThemeColor('charts.blue'),
      };
    }

    const conn = getConnections().find((c) => c.localPath && isInside(c.localPath, uri.fsPath));
    if (!conn) {
      return undefined;
    }
    if (!fs.existsSync(uri.fsPath) || fs.statSync(uri.fsPath).isDirectory()) {
      return undefined;
    }

    const relativePath = path.relative(conn.localPath, uri.fsPath).split(path.sep).join('/');
    const entry = this.manifestStore.get(conn.id)[relativePath];
    if (!entry?.local) {
      return undefined;
    }

    const stat = fs.statSync(uri.fsPath);
    const current = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000 };
    const changed = current.size !== entry.local.size || current.mtimeMs !== entry.local.mtimeMs;

    if (changed) {
      return {
        badge: '↑',
        tooltip: 'Modified locally — not yet synced to the server',
        color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      };
    }
    return {
      badge: '↓',
      tooltip: 'Downloaded from the server and in sync',
      color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    };
  }
}
