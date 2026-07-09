import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig } from '../connections/connectionConfig';
import { SyncManifestStore } from './syncManifest';
import { hasUnexpectedChange } from './conflictDetector';
import { walkLocalFiles } from './uploadChanges';

/**
 * Counts local files that would be uploaded by "Sync Now" right now — new
 * files never synced, plus files that changed since the last sync. Mirrors
 * the same skip condition uploadChanges() uses, so the count always matches
 * what a sync would actually do.
 */
export function countPendingUploads(conn: ConnectionConfig, manifestStore: SyncManifestStore): number {
  if (!conn.localPath || !fs.existsSync(conn.localPath)) {
    return 0;
  }
  const manifest = manifestStore.get(conn.id);
  let count = 0;
  for (const localFilePath of walkLocalFiles(conn.localPath)) {
    const relativePath = path.relative(conn.localPath, localFilePath).split(path.sep).join('/');
    const stat = fs.statSync(localFilePath);
    const localEntry = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000 };
    const lastSynced = manifest[relativePath];
    if (lastSynced && !hasUnexpectedChange(lastSynced.local, localEntry)) {
      continue;
    }
    count++;
  }
  return count;
}
