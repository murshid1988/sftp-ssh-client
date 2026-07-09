import * as vscode from 'vscode';
import * as path from 'path';

export type AuthType = 'password' | 'privateKey' | 'agent' | 'sshConfig';
export type SyncMode = 'manual' | 'auto';

export interface ConnectionConfig {
  id: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string;
  remotePath: string;
  localPath: string;
  syncMode: SyncMode;
}

export function getConnections(): ConnectionConfig[] {
  const raw = vscode.workspace.getConfiguration('sftpSsh').get<Partial<ConnectionConfig>[]>('connections', []);
  return raw.map((c) => ({
    id: c.id ?? '',
    host: c.host ?? '',
    port: c.port ?? 22,
    username: c.username ?? '',
    authType: c.authType ?? 'password',
    privateKeyPath: c.privateKeyPath,
    remotePath: c.remotePath ?? '',
    localPath: c.localPath ?? '',
    syncMode: c.syncMode ?? 'manual',
  }));
}

export function getConnectionById(id: string): ConnectionConfig | undefined {
  return getConnections().find((c) => c.id === id);
}

export function getAutoSyncPollIntervalSeconds(): number {
  return vscode.workspace.getConfiguration('sftpSsh').get<number>('autoSyncPollIntervalSeconds', 30);
}

/** Finds the connection whose local folder contains (or equals) the given path, if any. */
export function findConnectionForLocalPath(fsPath: string): ConnectionConfig | undefined {
  return getConnections().find((c) => {
    if (!c.localPath) {
      return false;
    }
    const rel = path.relative(c.localPath, fsPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}
