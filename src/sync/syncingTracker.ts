import * as vscode from 'vscode';

/**
 * Tracks which local files are mid-transfer right now, so the Explorer
 * decorations and the SFTP/SSH tree view can both show a live "syncing" icon
 * for the same file without duplicating state.
 */
export class SyncingTracker {
  private readonly activePaths = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;

  isSyncing(localPath: string): boolean {
    return this.activePaths.has(localPath);
  }

  get activeCount(): number {
    return this.activePaths.size;
  }

  start(localPath: string): void {
    this.activePaths.add(localPath);
    this.emitter.fire(localPath);
  }

  finish(localPath: string): void {
    this.activePaths.delete(localPath);
    this.emitter.fire(localPath);
  }
}
