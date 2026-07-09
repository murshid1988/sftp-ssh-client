import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SFTPWrapper } from 'ssh2';
import { ConnectionConfig } from '../connections/connectionConfig';
import { joinRemote, mkdirpRemote, statRemote, uploadFile } from '../ssh/sftpService';
import { StatEntry, Manifest, SyncManifestStore } from './syncManifest';
import { hasUnexpectedChange } from './conflictDetector';
import { SyncingTracker } from './syncingTracker';
import { forceDownloadOneFile } from './downloadWorkspace';

export interface UploadResult {
  uploaded: number;
  skippedConflicts: string[];
  downloadedInstead: string[];
}

export function walkLocalFiles(root: string): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

function toStatEntry(stats: { size: number; mtime: number }): StatEntry {
  return { size: stats.size, mtimeMs: stats.mtime * 1000 };
}

async function tryStatRemote(sftp: SFTPWrapper, remotePath: string): Promise<StatEntry | undefined> {
  try {
    return toStatEntry(await statRemote(sftp, remotePath));
  } catch {
    return undefined;
  }
}

type UploadOutcome = 'uploaded' | 'skipped' | 'unchanged' | 'downloadedInstead';

async function uploadOneFile(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  localFilePath: string,
  manifest: Manifest,
  tracker: SyncingTracker | undefined,
): Promise<UploadOutcome> {
  const relativePath = path.relative(conn.localPath, localFilePath).split(path.sep).join('/');
  const stat = fs.statSync(localFilePath);
  const localEntry: StatEntry = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000 };
  const existingEntry = manifest[relativePath];

  if (existingEntry && !hasUnexpectedChange(existingEntry.local, localEntry)) {
    return 'unchanged';
  }

  const remotePath = joinRemote(conn.remotePath, relativePath);
  const currentRemote = await tryStatRemote(sftp, remotePath);
  // Compare the server's CURRENT file against what we actually downloaded/
  // uploaded last time (entry.remote) — not against our local write time,
  // which is a different clock and would look "changed" on every sync.
  if (currentRemote && hasUnexpectedChange(existingEntry?.remote, currentRemote)) {
    const choice = await vscode.window.showWarningMessage(
      `"${relativePath}" changed on the server since the last sync. What would you like to do?`,
      { modal: true },
      'Overwrite Remote',
      'Get Latest From Server',
      'Skip',
    );
    if (choice === 'Get Latest From Server') {
      await forceDownloadOneFile(sftp, conn, remotePath, manifest, tracker);
      return 'downloadedInstead';
    }
    if (choice !== 'Overwrite Remote') {
      return 'skipped';
    }
  }

  await mkdirpRemote(sftp, path.posix.dirname(remotePath));
  tracker?.start(localFilePath);
  try {
    await uploadFile(sftp, localFilePath, remotePath);
  } finally {
    tracker?.finish(localFilePath);
  }

  // The server may adjust mtime on write (or round precision), so re-stat
  // rather than assuming it now matches the local file exactly.
  const remoteAfterUpload = (await tryStatRemote(sftp, remotePath)) ?? { size: localEntry.size, mtimeMs: localEntry.mtimeMs };
  manifest[relativePath] = { local: localEntry, remote: remoteAfterUpload };
  return 'uploaded';
}

export async function uploadChanges(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  manifestStore: SyncManifestStore,
  tracker?: SyncingTracker,
): Promise<UploadResult> {
  return uploadLocalPath(sftp, conn, conn.localPath, manifestStore, tracker);
}

/**
 * Uploads a single local file, or a local folder and everything under it,
 * to the matching location under conn.remotePath. Used both for "Sync Now"
 * (localTargetPath === conn.localPath) and for syncing an individual
 * file/folder picked from the Explorer.
 */
export async function uploadLocalPath(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  localTargetPath: string,
  manifestStore: SyncManifestStore,
  tracker?: SyncingTracker,
): Promise<UploadResult> {
  const manifest = manifestStore.get(conn.id);
  const skippedConflicts: string[] = [];
  const downloadedInstead: string[] = [];
  let uploaded = 0;

  const targets = fs.statSync(localTargetPath).isDirectory() ? walkLocalFiles(localTargetPath) : [localTargetPath];

  for (const localFilePath of targets) {
    const result = await uploadOneFile(sftp, conn, localFilePath, manifest, tracker);
    const relativePath = path.relative(conn.localPath, localFilePath).split(path.sep).join('/');
    if (result === 'uploaded') {
      uploaded++;
    } else if (result === 'skipped') {
      skippedConflicts.push(relativePath);
    } else if (result === 'downloadedInstead') {
      downloadedInstead.push(relativePath);
    }
  }

  await manifestStore.set(conn.id, manifest);
  return { uploaded, skippedConflicts, downloadedInstead };
}
