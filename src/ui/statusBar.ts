import * as vscode from 'vscode';

const MIN_SYNCING_DISPLAY_MS = 1500;

export class SftpStatusBar {
  private readonly item: vscode.StatusBarItem;
  private idleText = 'SFTP/SSH';
  private idleTooltip = 'SFTP/SSH Client';
  private syncingCount = 0;
  private syncingShownAt = 0;
  private hideTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'sftpSsh.showMenu';
    this.render();
    this.item.show();
  }

  setState(text: string, tooltip?: string): void {
    this.idleText = text;
    if (tooltip) {
      this.idleTooltip = tooltip;
    }
    this.render();
  }

  /**
   * Reflects background auto-sync activity without popping a notification
   * per file. A single small file often uploads in well under a second, so
   * the "Syncing…" state is held visible for a minimum duration instead of
   * flashing on and off faster than it can be noticed.
   */
  setSyncingCount(count: number): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }

    if (count > 0) {
      if (this.syncingCount === 0) {
        this.syncingShownAt = Date.now();
      }
      this.syncingCount = count;
      this.render();
      return;
    }

    const elapsed = Date.now() - this.syncingShownAt;
    const remaining = MIN_SYNCING_DISPLAY_MS - elapsed;
    if (remaining > 0) {
      this.hideTimer = setTimeout(() => {
        this.syncingCount = 0;
        this.render();
      }, remaining);
    } else {
      this.syncingCount = 0;
      this.render();
    }
  }

  private render(): void {
    if (this.syncingCount > 0) {
      this.item.text = `$(sync~spin) Syncing ${this.syncingCount} file${this.syncingCount === 1 ? '' : 's'}…`;
      this.item.tooltip = 'SFTP/SSH: sync in progress';
    } else {
      this.item.text = `$(cloud) ${this.idleText}`;
      this.item.tooltip = this.idleTooltip;
    }
  }

  dispose(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }
    this.item.dispose();
  }
}
