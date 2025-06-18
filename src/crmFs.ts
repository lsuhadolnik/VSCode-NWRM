import * as vscode from 'vscode';
import fetch from 'node-fetch';

export interface WebResource {
  id: string;
  name: string;
}

interface DirEntry {
  type: vscode.FileType.Directory;
  children: Map<string, Entry>;
}
interface FileEntry {
  type: vscode.FileType.File;
  id?: string;
}
type Entry = DirEntry | FileEntry;

export class CrmFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

  private root: DirEntry = { type: vscode.FileType.Directory, children: new Map() };
  private accessToken?: string;
  private apiUrl?: string;
  private output?: vscode.OutputChannel;

  constructor(output?: vscode.OutputChannel) {
    this.output = output;
  }

  watch(): vscode.Disposable {
    // polling not implemented
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this._lookup(uri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: entry.type,
      ctime: 0,
      mtime: 0,
      size: 0,
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const entry = this._lookupAsDirectory(uri);
    return Array.from(entry.children).map(([name, child]) => [name, child.type]);
  }

  // readFile fetches content when a file is opened
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const file = this._lookupAsFile(uri);
    if (!file.id) {
      return new Uint8Array();
    }
    if (!this.accessToken || !this.apiUrl) {
      throw vscode.FileSystemError.Unavailable('Not connected');
    }
    this.output?.appendLine(`Fetching ${uri.path}`);
    const url = `${this.apiUrl}/api/data/v9.2/webresourceset(${file.id})?$select=content`;
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    this.output?.appendLine(`GET ${url}`);
    this.output?.appendLine(
      `Request Headers: ${JSON.stringify({ Authorization: 'Bearer ***' })}`,
    );
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const body = await resp.text();
      this.output?.appendLine(`Failed to fetch ${uri.path}: ${resp.status} ${body}`);
      throw vscode.FileSystemError.Unavailable(`Failed to fetch ${uri.path}`);
    }
    const json = await resp.json();
    const base64 = json.content as string;
    return Buffer.from(base64, 'base64');
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    if (!this.accessToken || !this.apiUrl) {
      throw vscode.FileSystemError.Unavailable('Not connected');
    }
    const existing = this._lookup(uri);
    const data = Buffer.from(content).toString('base64');
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
    if (existing && existing.type === vscode.FileType.File) {
      if (existing.id) {
        if (data.length === 0) {
          // skip updating empty content
        } else {
          const url = `${this.apiUrl}/api/data/v9.2/webresourceset(${existing.id})`;
          this.output?.appendLine(`PATCH ${url}`);
          const resp = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ content: data }),
          });
          if (!resp.ok) {
            const body = await resp.text();
            this.output?.appendLine(`Failed to update ${uri.path}: ${resp.status} ${body}`);
            throw vscode.FileSystemError.Unavailable(`Failed to update ${uri.path}`);
          }
        }
      } else if (data.length > 0) {
        const name = uri.path.replace(/^\/+/, '');
        const type = this._getTypeFromExtension(name);
        const url = `${this.apiUrl}/api/data/v9.2/webresourceset`;
        this.output?.appendLine(`POST ${url}`);
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name,
            displayname: name,
            webresourcetype: type,
            content: data,
          }),
        });
        const rawHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          rawHeaders[k] = v;
        });
        const text = await resp.text();
        this.output?.appendLine(`Response Headers: ${JSON.stringify(rawHeaders)}`);
        this.output?.appendLine(`Response Body: ${text}`);
        if (!resp.ok) {
          this.output?.appendLine(`Failed to create ${uri.path}: ${resp.status} ${text}`);
          throw vscode.FileSystemError.Unavailable(`Failed to create ${uri.path}`);
        }
        let id: string | undefined;
        if (text) {
          try {
            const json = JSON.parse(text);
            id = json.webresourceid as string;
          } catch {
            // ignore parse errors
          }
        }
        existing.id = id;
      }
    } else if (!existing && options.create) {
      const name = uri.path.replace(/^\/+/, '');
      if (data.length === 0) {
        this._addEntry(name);
      } else {
        const type = this._getTypeFromExtension(name);
        const url = `${this.apiUrl}/api/data/v9.2/webresourceset`;
        this.output?.appendLine(`POST ${url}`);
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name,
            displayname: name,
            webresourcetype: type,
            content: data,
          }),
        });
        const text = await resp.text();
        if (!resp.ok) {
          this.output?.appendLine(`Failed to create ${uri.path}: ${resp.status} ${text}`);
          throw vscode.FileSystemError.Unavailable(`Failed to create ${uri.path}`);
        }
        let id: string | undefined;
        if (text) {
          try {
            const json = JSON.parse(text);
            id = json.webresourceid as string;
          } catch {
            // ignore parse errors
          }
        }
        this._addEntry(name, id);
      }
    } else {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  createDirectory(uri: vscode.Uri): void {
    const parts = uri.path.split('/').slice(1);
    let dir = this.root;
    for (const part of parts) {
      let child = dir.children.get(part);
      if (!child) {
        child = { type: vscode.FileType.Directory, children: new Map() } as DirEntry;
        dir.children.set(part, child);
      } else if (child.type !== vscode.FileType.Directory) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      dir = child as DirEntry;
    }
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const entry = this._lookup(uri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry.type === vscode.FileType.File) {
      if (!this.accessToken || !this.apiUrl) {
        throw vscode.FileSystemError.Unavailable('Not connected');
      }
      const url = `${this.apiUrl}/api/data/v9.2/webresourceset(${entry.id})`;
      this.output?.appendLine(`DELETE ${url}`);
      const resp = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!resp.ok) {
        const body = await resp.text();
        this.output?.appendLine(`Failed to delete ${uri.path}: ${resp.status} ${body}`);
        throw vscode.FileSystemError.Unavailable(`Failed to delete ${uri.path}`);
      }
      await this._publish(entry.id);
    }
    const parent = vscode.Uri.joinPath(uri, '..');
    const parentEntry = this._lookupAsDirectory(parent);
    parentEntry.children.delete(uri.path.split('/').pop() || '');
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    const entry = this._lookup(oldUri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }
    if (!options.overwrite && this._lookup(newUri)) {
      throw vscode.FileSystemError.FileExists(newUri);
    }
    if (entry.type === vscode.FileType.File) {
      const name = newUri.path.replace(/^\/+/, '');
      if (entry.id) {
        if (!this.accessToken || !this.apiUrl) {
          throw vscode.FileSystemError.Unavailable('Not connected');
        }
        const url = `${this.apiUrl}/api/data/v9.2/webresourceset(${entry.id})`;
        this.output?.appendLine(`PATCH ${url}`);
        const resp = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, displayname: name }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          this.output?.appendLine(`Failed to rename ${oldUri.path}: ${resp.status} ${body}`);
          throw vscode.FileSystemError.Unavailable(`Failed to rename ${oldUri.path}`);
        }
        await this._publish(entry.id);
      }
      const parentOld = this._lookupAsDirectory(vscode.Uri.joinPath(oldUri, '..'));
      parentOld.children.delete(oldUri.path.split('/').pop() || '');
      this._addEntry(name, entry.id);
    } else {
      // directory rename only updates local tree
      const oldParent = this._lookupAsDirectory(vscode.Uri.joinPath(oldUri, '..'));
      const child = oldParent.children.get(oldUri.path.split('/').pop() || '');
      if (!child) {
        throw vscode.FileSystemError.FileNotFound(oldUri);
      }
      oldParent.children.delete(oldUri.path.split('/').pop() || '');
      const newParent = this._lookupAsDirectory(vscode.Uri.joinPath(newUri, '..'));
      newParent.children.set(newUri.path.split('/').pop() || '', child);
    }
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, oldUri, newUri } as any]);
  }

  async load(accessToken: string, apiUrl: string): Promise<number> {
    this.accessToken = accessToken;
    this.apiUrl = apiUrl.replace(/\/?$/, '');
    this.root.children.clear();
    this.output?.appendLine(`Loading web resources from ${this.apiUrl}`);

    let count = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading web resources...' },
      async () => {
        let url = `${this.apiUrl}/api/data/v9.2/webresourceset?$select=webresourceid,name`;
        const headers = { Authorization: `Bearer ${this.accessToken}` };
        while (url) {
          this.output?.appendLine(`GET ${url}`);
          this.output?.appendLine(
            `Request Headers: ${JSON.stringify({ Authorization: 'Bearer ***' })}`,
          );
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const body = await resp.text();
            this.output?.appendLine(`Failed to list webresources: ${resp.status} ${body}`);
            throw new Error(`Failed to list webresources: ${resp.status}`);
          }
          const json = await resp.json();
          for (const item of json.value as { webresourceid: string; name: string }[]) {
            if (this._isExcluded(item.name)) {
              continue;
            }
            this._addEntry(item.name, item.webresourceid);
            count++;
          }
          url = json['@odata.nextLink'];
        }
      },
    );

    this.output?.appendLine(`Loaded ${count} web resources.`);
    await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.parse('crm:/') }]);
    return count;
  }

  private _isExcluded(name: string): boolean {
    return /^(msdyn_|mscrm_|adx_|microsoft)/i.test(name);
  }

  private _addEntry(resourceName: string, id?: string): void {
    const parts = resourceName.split('/');
    let dir = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let child = dir.children.get(part);
      if (!child) {
        child = { type: vscode.FileType.Directory, children: new Map() };
        dir.children.set(part, child);
      } else if (child.type !== vscode.FileType.Directory) {
        return; // skip malformed
      }
      dir = child as DirEntry;
    }
    const fileName = parts[parts.length - 1];
    dir.children.set(fileName, { type: vscode.FileType.File, id });
  }

  private _lookup(uri: vscode.Uri): Entry | undefined {
    if (uri.path === '/') {
      return this.root;
    }
    const parts = uri.path.split('/').slice(1); // remove leading empty
    let entry: Entry = this.root;
    for (const part of parts) {
      if (entry.type !== vscode.FileType.Directory) {
        return undefined;
      }
      entry = entry.children.get(part) as Entry;
      if (!entry) {
        return undefined;
      }
    }
    return entry;
  }

  private _lookupAsDirectory(uri: vscode.Uri): DirEntry {
    const entry = this._lookup(uri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotADirectory(uri);
    }
    return entry;
  }

  private _lookupAsFile(uri: vscode.Uri): FileEntry {
    const entry = this._lookup(uri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry.type !== vscode.FileType.File) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    return entry;
  }

  async publish(uri: vscode.Uri): Promise<void> {
    const entry = this._lookupAsFile(uri);
    if (entry.id) {
      this.output?.appendLine(`Publishing ${uri.path}`);
      await this._publish(entry.id);
    }
  }

  private _getTypeFromExtension(name: string): number {
    if (name.endsWith('.html') || name.endsWith('.htm')) {
      return 1;
    }
    if (name.endsWith('.js')) {
      return 3;
    }
    if (name.endsWith('.css')) {
      return 2;
    }
    return 1;
  }

  private async _publish(id?: string): Promise<void> {
    if (!id || !this.accessToken || !this.apiUrl) {
      return;
    }
    const xml = `<importexportxml><webresources><webresource>${id}</webresource></webresources></importexportxml>`;
    const url = `${this.apiUrl}/api/data/v9.2/PublishXml`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ParameterXml: xml }),
    });
  }
}
