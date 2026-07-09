import { Client, SFTPWrapper } from 'ssh2';

export interface RemoteFileInfo {
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err);
      } else {
        resolve(sftp);
      }
    });
  });
}

export async function listRemoteTree(sftp: SFTPWrapper, remoteRoot: string): Promise<RemoteFileInfo[]> {
  const results: RemoteFileInfo[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(sftp, dir);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') {
        continue;
      }
      const fullPath = joinRemote(dir, entry.filename);
      const isDirectory = (entry.attrs.mode & 0o170000) === 0o040000;
      if (isDirectory) {
        results.push({ path: fullPath, isDirectory: true, size: 0, mtimeMs: entry.attrs.mtime * 1000 });
        await walk(fullPath);
      } else {
        results.push({
          path: fullPath,
          isDirectory: false,
          size: entry.attrs.size,
          mtimeMs: entry.attrs.mtime * 1000,
        });
      }
    }
  }

  await walk(remoteRoot);
  return results;
}

export function readdir(sftp: SFTPWrapper, dir: string): Promise<import('ssh2').FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) {
        reject(err);
      } else {
        resolve(list);
      }
    });
  });
}

export function statRemote(sftp: SFTPWrapper, remotePath: string): Promise<import('ssh2').Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        resolve(stats);
      }
    });
  });
}

export function mkdirRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      if (err && !/failure|exist/i.test(err.message)) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export async function mkdirpRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split('/').filter(Boolean);
  let current = remotePath.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current ? `${current}/${part}` : `/${part}`;
    try {
      await statRemote(sftp, current);
    } catch {
      await mkdirRemote(sftp, current);
    }
  }
}

export function downloadFile(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function uploadFile(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function joinRemote(...parts: string[]): string {
  return parts
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}
