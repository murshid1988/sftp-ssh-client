import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SFTPWrapper } from 'ssh2';
import { ConnectionConfig } from '../connections/connectionConfig';
import { listRemoteTree, downloadFile, statRemote, RemoteFileInfo } from '../ssh/sftpService';
import { SyncManifestStore, Manifest, StatEntry } from './syncManifest';
import { hasUnexpectedChange } from './conflictDetector';
import { SyncingTracker } from './syncingTracker';

export interface DownloadResult {
  downloaded: number;
  skippedConflicts: string[];
}

function toStatEntry(stats: { size: number; mtime: number }): StatEntry {
  return { size: stats.size, mtimeMs: stats.mtime * 1000 };
}

/**
 * Downloads one file, recording BOTH the resulting local stat and the remote
 * stat it came from — so a later upload can compare the server's current
 * mtime against what we actually downloaded, instead of against our own
 * local write time (which is a different clock and would falsely look like
 * the server changed on every single sync).
 */
async function downloadOneFile(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  remoteFilePath: string,
  remoteStat: StatEntry,
  manifest: Manifest,
  tracker: SyncingTracker | undefined,
  force: boolean,
): Promise<'downloaded' | 'skipped'> {
  const relativePath = path.posix.relative(conn.remotePath, remoteFilePath);
  const localFilePath = path.join(conn.localPath, relativePath);

  if (!force && fs.existsSync(localFilePath)) {
    const localStat = fs.statSync(localFilePath);
    const localEntry = { size: localStat.size, mtimeMs: Math.floor(localStat.mtimeMs / 1000) * 1000 };
    const lastSynced = manifest[relativePath]?.local;
    if (hasUnexpectedChange(lastSynced, localEntry)) {
      const choice = await vscode.window.showWarningMessage(
        `"${relativePath}" changed locally since the last sync. Overwrite it with the remote version?`,
        { modal: true },
        'Overwrite Local',
        'Skip',
      );
      if (choice !== 'Overwrite Local') {
        return 'skipped';
      }
    }
  }

  fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
  tracker?.start(localFilePath);
  try {
    await downloadFile(sftp, remoteFilePath, localFilePath);
  } finally {
    tracker?.finish(localFilePath);
  }

  const newStat = fs.statSync(localFilePath);
  manifest[relativePath] = {
    local: { size: newStat.size, mtimeMs: Math.floor(newStat.mtimeMs / 1000) * 1000 },
    remote: remoteStat,
  };
  return 'downloaded';
}

/**
 * Overwrites the local copy with the remote version without asking — used
 * when the user already explicitly chose "get the latest from the server"
 * while resolving an upload conflict. Mutates the caller's in-memory
 * manifest directly (instead of round-tripping through SyncManifestStore)
 * so it composes safely inside uploadLocalPath's own per-file manifest loop.
 */
export async function forceDownloadOneFile(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  remoteFilePath: string,
  manifest: Manifest,
  tracker?: SyncingTracker,
): Promise<void> {
  const stats = await statRemote(sftp, remoteFilePath);
  await downloadOneFile(sftp, conn, remoteFilePath, toStatEntry(stats), manifest, tracker, true);
}

export async function downloadWorkspace(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  manifestStore: SyncManifestStore,
  tracker?: SyncingTracker,
): Promise<DownloadResult> {
  return downloadRemotePath(sftp, conn, conn.remotePath, manifestStore, tracker);
}

/**
 * Downloads a single remote file, or a remote folder and everything under it,
 * into the matching location under conn.localPath. Used both for "Download
 * Workspace" (remoteTargetPath === conn.remotePath) and for downloading an
 * individual file/folder picked from the remote tree view.
 */
export async function downloadRemotePath(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  remoteTargetPath: string,
  manifestStore: SyncManifestStore,
  tracker?: SyncingTracker,
): Promise<DownloadResult> {
  const manifest = manifestStore.get(conn.id);
  const skippedConflicts: string[] = [];
  let downloaded = 0;

  fs.mkdirSync(conn.localPath, { recursive: true });

  const targetStat = await statRemote(sftp, remoteTargetPath);
  const isDirectory = (targetStat.mode & 0o170000) === 0o040000;

  if (!isDirectory) {
    const result = await downloadOneFile(sftp, conn, remoteTargetPath, toStatEntry(targetStat), manifest, tracker, false);
    if (result === 'downloaded') {
      downloaded++;
    } else {
      skippedConflicts.push(path.posix.relative(conn.remotePath, remoteTargetPath));
    }
    await manifestStore.set(conn.id, manifest);
    return { downloaded, skippedConflicts };
  }

  const remoteFiles: RemoteFileInfo[] = await listRemoteTree(sftp, remoteTargetPath);
  const subDirRelativePaths: string[] = [];
  for (const remoteFile of remoteFiles) {
    const relativePath = path.posix.relative(conn.remotePath, remoteFile.path);
    if (remoteFile.isDirectory) {
      fs.mkdirSync(path.join(conn.localPath, relativePath), { recursive: true });
      subDirRelativePaths.push(relativePath);
      continue;
    }
    const result = await downloadOneFile(
      sftp,
      conn,
      remoteFile.path,
      { size: remoteFile.size, mtimeMs: remoteFile.mtimeMs },
      manifest,
      tracker,
      false,
    );
    if (result === 'downloaded') {
      downloaded++;
    } else {
      skippedConflicts.push(relativePath);
    }
  }

  await manifestStore.set(conn.id, manifest);

  // Only vouch for "fully downloaded" when nothing was skipped — otherwise we
  // can't be sure every file underneath actually made it down.
  if (skippedConflicts.length === 0) {
    const targetRelativePath = path.posix.relative(conn.remotePath, remoteTargetPath);
    await manifestStore.markFolderFullyDownloaded(conn.id, targetRelativePath);
    for (const subDir of subDirRelativePaths) {
      await manifestStore.markFolderFullyDownloaded(conn.id, subDir);
    }
  }

  return { downloaded, skippedConflicts };
}
