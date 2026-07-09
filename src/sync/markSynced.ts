import * as fs from 'fs';
import * as path from 'path';
import { SFTPWrapper } from 'ssh2';
import { ConnectionConfig } from '../connections/connectionConfig';
import { listRemoteTree, statRemote } from '../ssh/sftpService';
import { SyncManifestStore, StatEntry } from './syncManifest';

export interface MarkSyncedResult {
  marked: number;
  skippedNoLocalCounterpart: string[];
}

function toStatEntry(stats: { size: number; mtime: number }): StatEntry {
  return { size: stats.size, mtimeMs: stats.mtime * 1000 };
}

function localStatEntry(localFilePath: string): StatEntry {
  const stat = fs.statSync(localFilePath);
  return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000 };
}

/**
 * Records a remote file/folder as already in sync with its local counterpart
 * WITHOUT transferring anything — for cases like changing a connection's
 * Remote Path, where the local files genuinely already match the server but
 * the tracking records no longer line up because the relative-path mapping
 * shifted. Only files that already exist locally get marked; anything
 * missing locally is left alone (still needs an actual download).
 */
export async function markRemotePathSynced(
  sftp: SFTPWrapper,
  conn: ConnectionConfig,
  remoteTargetPath: string,
  manifestStore: SyncManifestStore,
): Promise<MarkSyncedResult> {
  const manifest = manifestStore.get(conn.id);
  const skippedNoLocalCounterpart: string[] = [];
  let marked = 0;

  const targetStat = await statRemote(sftp, remoteTargetPath);
  const isDirectory = (targetStat.mode & 0o170000) === 0o040000;

  const markOne = (remoteFilePath: string, remoteStat: StatEntry): void => {
    const relativePath = path.posix.relative(conn.remotePath, remoteFilePath);
    const localFilePath = path.join(conn.localPath, relativePath);
    if (!fs.existsSync(localFilePath) || fs.statSync(localFilePath).isDirectory()) {
      skippedNoLocalCounterpart.push(relativePath);
      return;
    }
    manifest[relativePath] = { local: localStatEntry(localFilePath), remote: remoteStat };
    marked++;
  };

  if (!isDirectory) {
    markOne(remoteTargetPath, toStatEntry(targetStat));
    await manifestStore.set(conn.id, manifest);
    return { marked, skippedNoLocalCounterpart };
  }

  const remoteFiles = await listRemoteTree(sftp, remoteTargetPath);
  const subDirRelativePaths: string[] = [];
  for (const remoteFile of remoteFiles) {
    if (remoteFile.isDirectory) {
      subDirRelativePaths.push(path.posix.relative(conn.remotePath, remoteFile.path));
      continue;
    }
    markOne(remoteFile.path, { size: remoteFile.size, mtimeMs: remoteFile.mtimeMs });
  }

  await manifestStore.set(conn.id, manifest);

  if (skippedNoLocalCounterpart.length === 0) {
    const targetRelativePath = path.posix.relative(conn.remotePath, remoteTargetPath);
    await manifestStore.markFolderFullyDownloaded(conn.id, targetRelativePath);
    for (const subDir of subDirRelativePaths) {
      await manifestStore.markFolderFullyDownloaded(conn.id, subDir);
    }
  }

  return { marked, skippedNoLocalCounterpart };
}
