import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import { ConnectionConfig } from '../connections/connectionConfig';
import { SecretStore } from '../connections/secretStore';
import { findSshConfigHost } from './sshConfigImport';

export interface ConnectPrompts {
  getPassword: () => Promise<string | undefined>;
  getPassphrase: () => Promise<string | undefined>;
}

export async function buildConnectConfig(
  conn: ConnectionConfig,
  secrets: SecretStore,
  prompts: ConnectPrompts,
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    readyTimeout: 15000,
  };

  switch (conn.authType) {
    case 'password': {
      let password = await secrets.getPassword(conn.id);
      if (!password) {
        password = await prompts.getPassword();
        if (!password) {
          throw new Error('Password is required.');
        }
        await secrets.setPassword(conn.id, password);
      }
      return { ...base, password };
    }
    case 'privateKey': {
      if (!conn.privateKeyPath) {
        throw new Error(`Connection "${conn.id}" is missing a Private Key Path.`);
      }
      const keyPath = conn.privateKeyPath.replace(/^~/, os.homedir());
      const privateKey = fs.readFileSync(keyPath);
      let passphrase = await secrets.getPassphrase(conn.id);
      const cfg: ConnectConfig = { ...base, privateKey };
      if (isEncryptedKey(privateKey.toString('utf8')) && !passphrase) {
        passphrase = await prompts.getPassphrase();
        if (passphrase) {
          await secrets.setPassphrase(conn.id, passphrase);
        }
      }
      if (passphrase) {
        cfg.passphrase = passphrase;
      }
      return cfg;
    }
    case 'agent': {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        throw new Error('SSH_AUTH_SOCK is not set — is an SSH agent running?');
      }
      return { ...base, agent: sock };
    }
    case 'sshConfig': {
      const entry = findSshConfigHost(conn.host);
      if (!entry) {
        throw new Error(`No entry for "${conn.host}" found in ~/.ssh/config.`);
      }
      const resolved: ConnectConfig = {
        ...base,
        host: entry.hostName ?? conn.host,
        port: entry.port ?? conn.port,
        username: entry.user ?? conn.username,
      };
      if (entry.identityFile && fs.existsSync(entry.identityFile)) {
        resolved.privateKey = fs.readFileSync(entry.identityFile);
      } else if (process.env.SSH_AUTH_SOCK) {
        resolved.agent = process.env.SSH_AUTH_SOCK;
      }
      return resolved;
    }
  }
}

function isEncryptedKey(pem: string): boolean {
  return pem.includes('ENCRYPTED') || pem.includes('Proc-Type: 4,ENCRYPTED');
}

export function connect(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', (err) => reject(err));
    client.connect(config);
  });
}
