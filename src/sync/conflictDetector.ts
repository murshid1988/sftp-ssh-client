import { StatEntry } from './syncManifest';

/**
 * A file changed unexpectedly if its current size/mtime differ from what was
 * recorded at the last successful sync, meaning something touched it outside
 * of this extension (e.g. a direct edit on the server, or the file was
 * changed locally without being uploaded yet).
 */
export function hasUnexpectedChange(lastSynced: StatEntry | undefined, current: StatEntry): boolean {
  if (!lastSynced) {
    // Never synced before — not a conflict, just a new file.
    return false;
  }
  return lastSynced.size !== current.size || lastSynced.mtimeMs !== current.mtimeMs;
}
