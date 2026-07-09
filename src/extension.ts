import * as vscode from 'vscode';
import { getConnections } from './connections/connectionConfig';
import { SecretStore } from './connections/secretStore';
import { ConnectionManager } from './connections/connectionManager';
import { SyncManifestStore } from './sync/syncManifest';
import { SyncingTracker } from './sync/syncingTracker';
import { AutoSyncManager } from './sync/autoSyncWatcher';
import { registerCommands } from './ui/commands';
import { SftpStatusBar } from './ui/statusBar';
import { ConnectionsTreeProvider } from './ui/connectionsTreeProvider';
import { SyncDecorationProvider } from './ui/syncDecorationProvider';
import { LocalChangeWatcher } from './ui/localWatcher';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SFTP/SSH Client');
  const secrets = new SecretStore(context.secrets);
  const connectionManager = new ConnectionManager(secrets);
  const manifestStore = new SyncManifestStore(context.globalState);
  const syncingTracker = new SyncingTracker();
  const statusBar = new SftpStatusBar();
  const autoSyncManager = new AutoSyncManager(
    manifestStore,
    (conn) => connectionManager.getSftp(conn),
    (msg) => output.appendLine(msg),
    syncingTracker,
    (id, op) => connectionManager.runExclusive(id, op),
  );

  const treeProvider = new ConnectionsTreeProvider(connectionManager, autoSyncManager, manifestStore, syncingTracker);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('sftpSshConnections', treeProvider));

  const decorationProvider = new SyncDecorationProvider(manifestStore, syncingTracker);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

  context.subscriptions.push(
    syncingTracker.onDidChange(() => statusBar.setSyncingCount(syncingTracker.activeCount)),
  );

  registerCommands(context, connectionManager, manifestStore, autoSyncManager, statusBar, treeProvider, syncingTracker, output);

  const localChangeWatcher = new LocalChangeWatcher(treeProvider, decorationProvider, manifestStore);
  localChangeWatcher.sync(getConnections());

  for (const conn of getConnections()) {
    if (conn.syncMode === 'auto' && conn.id && conn.localPath) {
      autoSyncManager.start(conn);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('sftpSsh.connections')) {
        return;
      }
      const connections = getConnections();
      for (const conn of connections) {
        const shouldRun = conn.syncMode === 'auto' && conn.id && conn.localPath;
        if (shouldRun && !autoSyncManager.isActive(conn.id)) {
          autoSyncManager.start(conn);
        } else if (!shouldRun && conn.id) {
          autoSyncManager.stop(conn.id);
        }
      }
      localChangeWatcher.sync(connections);
      treeProvider.refresh();
      decorationProvider.refreshAll();
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      autoSyncManager.dispose();
      connectionManager.dispose();
      localChangeWatcher.dispose();
      statusBar.dispose();
      output.dispose();
    },
  });
}

export function deactivate(): void {
  // Cleanup handled via context.subscriptions disposables registered in activate().
}
