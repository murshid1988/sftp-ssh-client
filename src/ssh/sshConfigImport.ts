import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshConfigHostEntry {
  host: string;
  hostName?: string;
  port?: number;
  user?: string;
  identityFile?: string;
}

/**
 * Minimal ~/.ssh/config parser covering Host/HostName/Port/User/IdentityFile.
 * Good enough for autofill; not a full spec implementation (no Match/Include).
 */
export function parseSshConfig(configPath: string = path.join(os.homedir(), '.ssh', 'config')): SshConfigHostEntry[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
  const entries: SshConfigHostEntry[] = [];
  let current: SshConfigHostEntry | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, spaceIdx).toLowerCase();
    const value = trimmed.slice(spaceIdx + 1).trim().replace(/^"|"$/g, '');

    if (key === 'host') {
      if (current) {
        entries.push(current);
      }
      current = { host: value };
      continue;
    }
    if (!current) {
      continue;
    }
    switch (key) {
      case 'hostname':
        current.hostName = value;
        break;
      case 'port':
        current.port = Number(value);
        break;
      case 'user':
        current.user = value;
        break;
      case 'identityfile':
        current.identityFile = value.replace(/^~/, os.homedir());
        break;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export function findSshConfigHost(alias: string, configPath?: string): SshConfigHostEntry | undefined {
  return parseSshConfig(configPath).find((e) => e.host === alias);
}
