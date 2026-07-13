import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConnections, ConnectionConfig, findConnectionForLocalPath } from '../connections/connectionConfig';
import { ConnectionManager, TRANSFER_TIMEOUT_MS } from '../connections/connectionManager';
import { SyncManifestStore } from '../sync/syncManifest';
import { AutoSyncManager } from '../sync/autoSyncWatcher';
import { downloadWorkspace, downloadRemotePath } from '../sync/downloadWorkspace';
import { uploadChanges, uploadLocalPath, UploadResult } from '../sync/uploadChanges';
import { markRemotePathSynced } from '../sync/markSynced';
import { joinRemote } from '../ssh/sftpService';
import { SftpStatusBar } from './statusBar';
import { ConnectionManagerPanel } from './connectionManagerPanel';
import { ConnectionTreeItem, ConnectionsTreeProvider, RemoteEntryTreeItem } from './connectionsTreeProvider';
import { SyncingTracker } from '../sync/syncingTracker';

async function pickConnection(): Promise<ConnectionConfig | undefined> {
  const connections = getConnections();
  if (connections.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No SFTP/SSH connections configured yet.',
      'Add Connection',
    );
    if (choice === 'Add Connection') {
      vscode.commands.executeCommand('sftpSsh.manageConnections');
    }
    return undefined;
  }
  if (connections.length === 1) {
    return connections[0];
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((c) => ({ label: c.id, description: `${c.username}@${c.host}`, conn: c })),
    { placeHolder: 'Choose a connection' },
  );
  return picked?.conn;
}

// Tree view inline buttons pass a ConnectionTreeItem; Command Palette invocations pass nothing.
function formatUploadMessage(prefix: string, result: UploadResult): string {
  const parts = [`${prefix} ${result.uploaded} file(s)`];
  if (result.downloadedInstead.length) {
    parts.push(`downloaded ${result.downloadedInstead.length} newer server version(s) instead`);
  }
  if (result.skippedConflicts.length) {
    parts.push(`skipped ${result.skippedConflicts.length} conflict(s)`);
  }
  return `${parts.join(', ')}.`;
}

async function resolveConnection(arg: ConnectionTreeItem | ConnectionConfig | undefined): Promise<ConnectionConfig | undefined> {
  if (arg instanceof ConnectionTreeItem) {
    return arg.connection;
  }
  if (arg && typeof arg === 'object' && 'host' in arg) {
    return arg;
  }
  return pickConnection();
}

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  manifestStore: SyncManifestStore,
  autoSyncManager: AutoSyncManager,
  statusBar: SftpStatusBar,
  treeProvider: ConnectionsTreeProvider,
  syncingTracker: SyncingTracker,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sftpSsh.manageConnections', () => {
      ConnectionManagerPanel.createOrShow(connectionManager);
    }),

    vscode.commands.registerCommand('sftpSsh.refreshConnections', () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('sftpSsh.openLog', () => {
      output.show();
    }),

    vscode.commands.registerCommand('sftpSsh.showMenu', async () => {
      const items: (vscode.QuickPickItem & { command?: string })[] = [
        { label: '$(cloud-upload) Sync Now', command: 'sftpSsh.syncNow' },
        { label: '$(cloud-download) Download Workspace', command: 'sftpSsh.downloadWorkspace' },
        { label: '$(plug) Test Connection', command: 'sftpSsh.testConnection' },
        { label: '$(debug-disconnect) Disconnect', command: 'sftpSsh.disconnect' },
        { label: '$(sync) Toggle Auto-Sync', command: 'sftpSsh.toggleAutoSync' },
        { label: '$(gear) Manage Connections', command: 'sftpSsh.manageConnections' },
        { label: '$(output) Open Log', command: 'sftpSsh.openLog' },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'SFTP/SSH' });
      if (picked?.command) {
        await vscode.commands.executeCommand(picked.command);
      }
    }),

    vscode.commands.registerCommand('sftpSsh.testConnection', async (arg?: ConnectionTreeItem) => {
      const conn = await resolveConnection(arg);
      if (!conn) {
        return;
      }
      statusBar.setState('Connecting…');
      try {
        await connectionManager.getClient(conn);
        statusBar.setState('Connected', `Connected to ${conn.host}`);
        vscode.window.showInformationMessage(`Connected to "${conn.id}" successfully.`);
      } catch (err) {
        statusBar.setState('SFTP/SSH');
        vscode.window.showErrorMessage(`Connection to "${conn.id}" failed: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('sftpSsh.downloadWorkspace', async (arg?: ConnectionTreeItem) => {
      const conn = await resolveConnection(arg);
      if (!conn) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading "${conn.id}"…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(
              conn.id,
              async () => {
                const sftp = await connectionManager.getSftp(conn);
                return downloadWorkspace(sftp, conn, manifestStore, syncingTracker);
              },
              TRANSFER_TIMEOUT_MS,
            );
            const message =
              `Downloaded ${result.downloaded} file(s) for "${conn.id}"` +
              (result.skippedConflicts.length ? `, skipped ${result.skippedConflicts.length} conflict(s).` : '.');
            treeProvider.refresh();

            const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (currentFolder === conn.localPath) {
              vscode.window.showInformationMessage(message);
              return;
            }
            const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Open Folder');
            if (choice === 'Open Folder') {
              await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(conn.localPath), {
                forceNewWindow: false,
              });
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Download failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.syncNow', async (arg?: ConnectionTreeItem) => {
      const conn = await resolveConnection(arg);
      if (!conn) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Syncing "${conn.id}"…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(
              conn.id,
              async () => {
                const sftp = await connectionManager.getSftp(conn);
                return uploadChanges(sftp, conn, manifestStore, syncingTracker);
              },
              TRANSFER_TIMEOUT_MS,
            );
            vscode.window.showInformationMessage(formatUploadMessage(`Synced "${conn.id}":`, result));
            treeProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Sync failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.downloadRemoteItem', async (item: RemoteEntryTreeItem) => {
      if (!item) {
        return;
      }
      const conn = item.connection;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading "${item.relativePath}"…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(
              conn.id,
              async () => {
                const sftp = await connectionManager.getSftp(conn);
                return downloadRemotePath(sftp, conn, item.remotePath, manifestStore, syncingTracker);
              },
              TRANSFER_TIMEOUT_MS,
            );
            vscode.window.showInformationMessage(
              `Downloaded ${result.downloaded} file(s) from "${item.relativePath}"` +
                (result.skippedConflicts.length ? `, skipped ${result.skippedConflicts.length} conflict(s).` : '.'),
            );
            treeProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Download failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.markRemoteItemSynced', async (item: RemoteEntryTreeItem) => {
      if (!item) {
        return;
      }
      const conn = item.connection;
      const choice = await vscode.window.showInformationMessage(
        `Mark "${item.relativePath}" as already in sync? This only updates tracking — it won't transfer any files. Only use this if the local and remote copies genuinely already match (e.g. after changing this connection's Remote Path).`,
        { modal: true },
        'Mark as Synced',
      );
      if (choice !== 'Mark as Synced') {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Marking "${item.relativePath}" as synced…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(conn.id, async () => {
              const sftp = await connectionManager.getSftp(conn);
              return markRemotePathSynced(sftp, conn, item.remotePath, manifestStore);
            });
            vscode.window.showInformationMessage(
              `Marked ${result.marked} file(s) as synced` +
                (result.skippedNoLocalCounterpart.length
                  ? `, ${result.skippedNoLocalCounterpart.length} skipped (no local copy found — those still need an actual download).`
                  : '.'),
            );
            treeProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to mark as synced: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.uploadRemoteItem', async (item: RemoteEntryTreeItem) => {
      if (!item) {
        return;
      }
      const conn = item.connection;
      const localTargetPath = path.join(conn.localPath, item.relativePath);
      if (!fs.existsSync(localTargetPath)) {
        vscode.window.showWarningMessage(`"${item.relativePath}" doesn't exist locally — download it first before uploading.`);
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uploading "${item.relativePath}"…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(
              conn.id,
              async () => {
                const sftp = await connectionManager.getSftp(conn);
                return uploadLocalPath(sftp, conn, localTargetPath, manifestStore, syncingTracker);
              },
              TRANSFER_TIMEOUT_MS,
            );
            vscode.window.showInformationMessage(formatUploadMessage(`"${item.relativePath}":`, result));
            treeProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Upload failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.uploadFile', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        return;
      }
      const conn = findConnectionForLocalPath(targetUri.fsPath);
      if (!conn) {
        vscode.window.showWarningMessage("This file isn't inside any configured SFTP/SSH connection's local folder.");
        return;
      }
      const label = path.basename(targetUri.fsPath);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uploading "${label}"…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(
              conn.id,
              async () => {
                const sftp = await connectionManager.getSftp(conn);
                return uploadLocalPath(sftp, conn, targetUri.fsPath, manifestStore, syncingTracker);
              },
              TRANSFER_TIMEOUT_MS,
            );
            vscode.window.showInformationMessage(formatUploadMessage(`Uploaded to "${conn.id}":`, result));
            treeProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Upload failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.downloadFile', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        return;
      }
      const conn = findConnectionForLocalPath(targetUri.fsPath);
      if (!conn) {
        vscode.window.showWarningMessage("This file isn't inside any configured SFTP/SSH connection's local folder.");
        return;
      }
      const relativePath = path.relative(conn.localPath, targetUri.fsPath).split(path.sep).join('/');
      const remoteTargetPath = relativePath ? joinRemote(conn.remotePath, relativePath) : conn.remotePath;
      const label = path.basename(targetUri.fsPath);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading "${label}"…` },
        async () => {
          try {
            const result = await connectionManager.runExclusive(
              conn.id,
              async () => {
                const sftp = await connectionManager.getSftp(conn);
                return downloadRemotePath(sftp, conn, remoteTargetPath, manifestStore, syncingTracker);
              },
              TRANSFER_TIMEOUT_MS,
            );
            vscode.window.showInformationMessage(
              `Downloaded ${result.downloaded} file(s) from "${conn.id}"` +
                (result.skippedConflicts.length ? `, skipped ${result.skippedConflicts.length} conflict(s).` : '.'),
            );
            treeProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(`Download failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('sftpSsh.disconnect', async (arg?: ConnectionTreeItem) => {
      const conn = await resolveConnection(arg);
      if (!conn) {
        return;
      }
      connectionManager.disconnect(conn.id);
      statusBar.setState('SFTP/SSH');
      vscode.window.showInformationMessage(`Disconnected from "${conn.id}".`);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('sftpSsh.toggleAutoSync', async (arg?: ConnectionTreeItem) => {
      const conn = await resolveConnection(arg);
      if (!conn) {
        return;
      }
      if (autoSyncManager.isActive(conn.id)) {
        autoSyncManager.stop(conn.id);
        vscode.window.showInformationMessage(`Auto-sync stopped for "${conn.id}".`);
      } else {
        autoSyncManager.start(conn);
        vscode.window.showInformationMessage(`Auto-sync started for "${conn.id}".`);
      }
      treeProvider.refresh();
    }),
  );
}
