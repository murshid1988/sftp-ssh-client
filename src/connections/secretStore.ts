import * as vscode from 'vscode';

function passwordKey(connectionId: string): string {
  return `sftpSsh.password.${connectionId}`;
}

function passphraseKey(connectionId: string): string {
  return `sftpSsh.passphrase.${connectionId}`;
}

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getPassword(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(passwordKey(connectionId));
  }

  async setPassword(connectionId: string, value: string): Promise<void> {
    await this.secrets.store(passwordKey(connectionId), value);
  }

  async getPassphrase(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(passphraseKey(connectionId));
  }

  async setPassphrase(connectionId: string, value: string): Promise<void> {
    await this.secrets.store(passphraseKey(connectionId), value);
  }

  async clear(connectionId: string): Promise<void> {
    await this.secrets.delete(passwordKey(connectionId));
    await this.secrets.delete(passphraseKey(connectionId));
  }
}
