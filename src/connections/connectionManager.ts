import * as vscode from 'vscode';
import { Client, SFTPWrapper } from 'ssh2';
import { ConnectionConfig } from './connectionConfig';
import { SecretStore } from './secretStore';
import { buildConnectConfig, connect } from '../ssh/sshClient';
import { getSftp } from '../ssh/sftpService';

export class ConnectionManager {
  private readonly clients = new Map<string, Client>();
  private readonly sftpSessions = new Map<string, SFTPWrapper>();
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeConnectionState = this.stateEmitter.event;
  private readonly operationQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly secrets: SecretStore) {}

  /**
   * Runs one sync operation (download/upload/tree browse) for a connection
   * at a time. Without this, a download's own file writes can trigger the
   * auto-sync watcher's upload for the same connection concurrently — both
   * read/write the manifest independently, and whichever finishes last
   * silently overwrites the other's record of what's actually in sync.
   * Also guards against a stalled request permanently jamming every later
   * operation: if the SFTP channel drops a request without ever erroring
   * (rare, but happens on flaky connections), the queue would otherwise
   * wait forever. A timeout resets the connection and unblocks it instead.
   */
  async runExclusive<T>(connectionId: string, operation: () => Promise<T>, timeoutMs = 45000): Promise<T> {
    const previous = this.operationQueues.get(connectionId) ?? Promise.resolve();
    const run = () => this.withTimeout(connectionId, operation(), timeoutMs);
    const settle = previous.then(run, run);
    this.operationQueues.set(
      connectionId,
      settle.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settle;
  }

  private async withTimeout<T>(connectionId: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.disconnect(connectionId);
        reject(
          new Error(
            'Timed out waiting for the server — the connection may have stalled. It has been reset; please try again.',
          ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  isConnected(connectionId: string): boolean {
    return this.clients.has(connectionId);
  }

  async getClient(conn: ConnectionConfig): Promise<Client> {
    const existing = this.clients.get(conn.id);
    if (existing) {
      return existing;
    }

    const connectConfig = await buildConnectConfig(conn, this.secrets, {
      getPassword: () =>
        Promise.resolve(
          vscode.window.showInputBox({
            prompt: `Password for ${conn.username}@${conn.host}`,
            password: true,
            ignoreFocusOut: true,
          }),
        ),
      getPassphrase: () =>
        Promise.resolve(
          vscode.window.showInputBox({
            prompt: `Passphrase for private key (leave blank if none)`,
            password: true,
            ignoreFocusOut: true,
          }),
        ),
    });

    const client = await connect(connectConfig);
    client.on('close', () => {
      this.clients.delete(conn.id);
      this.sftpSessions.delete(conn.id);
      this.stateEmitter.fire();
    });
    client.on('error', () => {
      this.clients.delete(conn.id);
      this.sftpSessions.delete(conn.id);
      this.stateEmitter.fire();
    });
    this.clients.set(conn.id, client);
    this.stateEmitter.fire();
    return client;
  }

  /**
   * Returns a single shared SFTP channel per connection. Opening a new
   * channel per request (e.g. every tree-view folder expand) can exhaust
   * the server's session/channel limit when several requests fire at once.
   */
  async getSftp(conn: ConnectionConfig): Promise<SFTPWrapper> {
    const existing = this.sftpSessions.get(conn.id);
    if (existing) {
      return existing;
    }
    const client = await this.getClient(conn);
    const sftp = await getSftp(client);
    sftp.on('close', () => this.sftpSessions.delete(conn.id));
    this.sftpSessions.set(conn.id, sftp);
    return sftp;
  }

  disconnect(connectionId: string): void {
    const client = this.clients.get(connectionId);
    if (client) {
      client.end();
      this.clients.delete(connectionId);
      this.sftpSessions.delete(connectionId);
      this.stateEmitter.fire();
    }
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.end();
    }
    this.clients.clear();
    this.sftpSessions.clear();
  }
}
