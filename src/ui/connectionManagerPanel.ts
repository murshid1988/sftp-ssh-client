import * as vscode from 'vscode';
import { ConnectionConfig, getConnections } from '../connections/connectionConfig';
import { ConnectionManager } from '../connections/connectionManager';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'save'; connections: ConnectionConfig[] }
  | { type: 'testConnection'; connection: ConnectionConfig }
  | { type: 'browseKeyFile'; idx: number }
  | { type: 'browseLocalFolder'; idx: number };

type OutboundMessage =
  | { type: 'init'; connections: ConnectionConfig[] }
  | { type: 'saved' }
  | { type: 'testResult'; id: string; success: boolean; message: string }
  | { type: 'pathPicked'; idx: number; key: 'privateKeyPath' | 'localPath'; path: string };

export class ConnectionManagerPanel {
  private static current: ConnectionManagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(connectionManager: ConnectionManager): void {
    if (ConnectionManagerPanel.current) {
      ConnectionManagerPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sftpSshConnectionManager',
      'SFTP/SSH Connections',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ConnectionManagerPanel.current = new ConnectionManagerPanel(panel, connectionManager);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly connectionManager: ConnectionManager,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: InboundMessage) => this.handleMessage(msg), null, this.disposables);
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'init', connections: getConnections() });
        break;
      case 'save': {
        const problems = validateConnections(msg.connections);
        if (problems.length > 0) {
          vscode.window.showErrorMessage(`Fix these before saving: ${problems.join('; ')}`);
          return;
        }
        await vscode.workspace
          .getConfiguration('sftpSsh')
          .update('connections', msg.connections, vscode.ConfigurationTarget.Global);
        this.post({ type: 'saved' });
        vscode.window.showInformationMessage('SFTP/SSH connections saved.');
        break;
      }
      case 'testConnection':
        try {
          await this.connectionManager.getClient(msg.connection);
          this.post({ type: 'testResult', id: msg.connection.id, success: true, message: 'Connected successfully.' });
        } catch (err) {
          this.post({
            type: 'testResult',
            id: msg.connection.id,
            success: false,
            message: (err as Error).message,
          });
        }
        break;
      case 'browseKeyFile': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: 'Select Private Key',
        });
        if (picked && picked[0]) {
          this.post({ type: 'pathPicked', idx: msg.idx, key: 'privateKeyPath', path: picked[0].fsPath });
        }
        break;
      }
      case 'browseLocalFolder': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select Local Folder',
        });
        if (picked && picked[0]) {
          this.post({ type: 'pathPicked', idx: msg.idx, key: 'localPath', path: picked[0].fsPath });
        }
        break;
      }
    }
  }

  private post(msg: OutboundMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    ConnectionManagerPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  private render(): string {
    const nonce = String(Date.now());
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 20px 32px; max-width: 640px; }
  h2 { font-weight: 600; margin-bottom: 4px; }
  p.intro { opacity: 0.8; font-size: 13px; margin-top: 0; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; opacity: 0.8; margin-bottom: 3px; }
  .field-row { display: flex; gap: 10px; }
  .field-row .field { flex: 1; }
  input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; border-radius: 2px; font-size: 13px; }
  .path-field { display: flex; gap: 6px; }
  .path-field input { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; font-size: 13px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 4px 0; text-decoration: underline; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .card-header strong { font-size: 14px; }
  .advanced summary { cursor: pointer; font-size: 12px; opacity: 0.8; margin: 8px 0; }
  .status { font-size: 12px; margin-top: 8px; }
  .status.ok { color: var(--vscode-testing-iconPassed, #4caf50); }
  .status.err { color: var(--vscode-testing-iconFailed, #f44336); }
  .toolbar { margin: 16px 0; display: flex; gap: 8px; }
  .row-actions { display: flex; gap: 8px; }
</style>
</head>
<body>
  <h2>SFTP/SSH Connections</h2>
  <p class="intro">Add one card per server. Passwords and key passphrases are never entered here — you'll be prompted securely the first time you connect.</p>
  <div id="cards"></div>
  <div class="toolbar">
    <button id="addRow">+ Add Connection</button>
    <button id="saveAll">Save All</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let connections = [];

    function esc(v) {
      return (v ?? '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function selectHtml(idx, key, value, options, labels) {
      const opts = options.map((o, i) => \`<option value="\${o}" \${o === value ? 'selected' : ''}>\${labels ? labels[i] : o}</option>\`).join('');
      return \`<select data-idx="\${idx}" data-key="\${key}">\${opts}</select>\`;
    }

    function textHtml(idx, key, value, placeholder) {
      return \`<input data-idx="\${idx}" data-key="\${key}" type="text" value="\${esc(value)}" placeholder="\${placeholder ?? ''}" />\`;
    }

    function cardHtml(c, idx) {
      const authType = c.authType ?? 'password';
      const keyField = authType === 'privateKey' ? \`
        <div class="field">
          <label>Private Key File</label>
          <div class="path-field">
            \${textHtml(idx, 'privateKeyPath', c.privateKeyPath, '~/.ssh/id_ed25519')}
            <button class="secondary" data-action="browseKey" data-idx="\${idx}">Browse…</button>
          </div>
        </div>\` : '';
      const authHelp = {
        password: "You'll be prompted for the password the first time you connect.",
        privateKey: 'Pick the private key file used to log in.',
        agent: 'Uses the SSH agent already running on your computer — nothing else needed.',
        sshConfig: 'Reuses the matching Host entry from your ~/.ssh/config file.',
      }[authType];

      return \`
      <div class="card" data-idx="\${idx}">
        <div class="card-header">
          <strong>\${c.host ? esc(c.host) : 'New Connection'}</strong>
          <div class="row-actions">
            <button data-action="test" data-idx="\${idx}">Test Connection</button>
            <button class="secondary" data-action="remove" data-idx="\${idx}">Remove</button>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>Name</label>\${textHtml(idx, 'id', c.id, 'e.g. production-server')}</div>
          <div class="field"><label>Host</label>\${textHtml(idx, 'host', c.host, 'e.g. 192.0.2.10')}</div>
        </div>
        <div class="field-row">
          <div class="field"><label>Username</label>\${textHtml(idx, 'username', c.username, 'e.g. root')}</div>
          <div class="field"><label>Auth Type</label>\${selectHtml(idx, 'authType', authType, ['password', 'privateKey', 'agent', 'sshConfig'], ['Password', 'Private Key File', 'SSH Agent', 'From ~/.ssh/config'])}</div>
        </div>
        <p style="font-size:11px;opacity:0.7;margin:-4px 0 10px;">\${authHelp}</p>
        \${keyField}
        <div class="field">
          <label>Remote Folder (on the server)</label>
          \${textHtml(idx, 'remotePath', c.remotePath, '/var/www/myapp')}
        </div>
        <div class="field">
          <label>Local Folder (on your computer)</label>
          <div class="path-field">
            \${textHtml(idx, 'localPath', c.localPath, '')}
            <button class="secondary" data-action="browseLocal" data-idx="\${idx}">Browse…</button>
          </div>
        </div>
        <details class="advanced">
          <summary>Advanced</summary>
          <div class="field-row">
            <div class="field"><label>Port</label>\${textHtml(idx, 'port', c.port ?? 22)}</div>
            <div class="field"><label>Sync Mode</label>\${selectHtml(idx, 'syncMode', c.syncMode ?? 'manual', ['manual', 'auto'], ['Manual (I click Sync)', 'Auto (uploads as I save)'])}</div>
          </div>
        </details>
        <div class="status" id="status-\${idx}"></div>
      </div>\`;
    }

    function render() {
      const container = document.getElementById('cards');
      container.innerHTML = connections.map(cardHtml).join('') || '<p style="opacity:0.7">No connections yet — click "Add Connection" to create one.</p>';

      container.querySelectorAll('input, select').forEach((el) => {
        el.addEventListener('change', (e) => {
          const idx = Number(e.target.dataset.idx);
          const key = e.target.dataset.key;
          const value = key === 'port' ? Number(e.target.value) : e.target.value;
          connections[idx][key] = value;
          if (key === 'authType' || key === 'host') {
            render();
          }
        });
      });
      container.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          connections.splice(Number(e.target.dataset.idx), 1);
          render();
        });
      });
      container.querySelectorAll('button[data-action="test"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(e.target.dataset.idx);
          const el = document.getElementById('status-' + idx);
          el.textContent = 'Testing…';
          el.className = 'status';
          vscode.postMessage({ type: 'testConnection', connection: connections[idx] });
        });
      });
      container.querySelectorAll('button[data-action="browseKey"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          vscode.postMessage({ type: 'browseKeyFile', idx: Number(e.target.dataset.idx) });
        });
      });
      container.querySelectorAll('button[data-action="browseLocal"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          vscode.postMessage({ type: 'browseLocalFolder', idx: Number(e.target.dataset.idx) });
        });
      });
    }

    document.getElementById('addRow').addEventListener('click', () => {
      connections.push({ id: '', host: '', port: 22, username: '', authType: 'password', remotePath: '', localPath: '', syncMode: 'manual' });
      render();
    });

    document.getElementById('saveAll').addEventListener('click', () => {
      // Fill in a sensible Id from Host if the user left it blank.
      connections.forEach((c, idx) => {
        if (!c.id && c.host) {
          c.id = c.host;
        }
      });
      render();
      vscode.postMessage({ type: 'save', connections });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        connections = msg.connections;
        render();
      } else if (msg.type === 'testResult') {
        const idx = connections.findIndex((c) => c.id === msg.id);
        if (idx >= 0) {
          const el = document.getElementById('status-' + idx);
          el.textContent = msg.message;
          el.className = 'status ' + (msg.success ? 'ok' : 'err');
        }
      } else if (msg.type === 'pathPicked') {
        connections[msg.idx][msg.key] = msg.path;
        render();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function validateConnections(connections: ConnectionConfig[]): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  connections.forEach((c, idx) => {
    const label = c.host || `Connection #${idx + 1}`;
    if (!c.host) {
      problems.push(`${label}: Host is required`);
    }
    if (!c.username) {
      problems.push(`${label}: Username is required`);
    }
    if (!c.remotePath) {
      problems.push(`${label}: Remote Folder is required`);
    }
    if (!c.localPath) {
      problems.push(`${label}: Local Folder is required`);
    }
    if (c.authType === 'privateKey' && !c.privateKeyPath) {
      problems.push(`${label}: Private Key File is required for Private Key auth`);
    }
    if (c.id && seenIds.has(c.id)) {
      problems.push(`Name "${c.id}" is used more than once`);
    }
    if (c.id) {
      seenIds.add(c.id);
    }
  });
  return problems;
}
