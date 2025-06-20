import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as path from 'path';

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

import { ConnectionsProvider } from './connections';

export class CrmFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

  private root: DirEntry = { type: vscode.FileType.Directory, children: new Map() };
  private host?: string;
  private basePath = '';
  private rootUri?: vscode.Uri;
  private allowedExts: Set<string> = new Set();
  private loaded = false;
  private output?: vscode.OutputChannel;
  private connections: ConnectionsProvider;
  constructor(connections: ConnectionsProvider, output?: vscode.OutputChannel) {
    this.connections = connections;
    this.output = output;
  }

  private _ensureConnected(uri: vscode.Uri): void {
    if (!this.rootUri) {
      const host = uri.authority || uri.path.replace(/^\/+/, '').split('/')[0];
      const root = vscode.Uri.from({
        scheme: uri.scheme,
        authority: '',
        path: `/${host}`,
      });
      this.output?.appendLine(`Connecting to ${root.toString()}`);
      this.connect(root);
    }
  }

  private async _getConnection(): Promise<{ token: string; apiUrl: string } | undefined> {
    if (!this.host) {
      return undefined;
    }
    return this.connections.ensureConnection(this.host, this.output!);
  }

  connect(root: vscode.Uri): void {
    this.host = root.authority || root.path.replace(/^\/+/, '').split('/')[0];
    this.setBasePath(root);
    this.root.children.clear();
    this.loaded = false;
  }

  setBasePath(uri: vscode.Uri): void {
    this.rootUri = uri;
    this.basePath = uri.path;
    this.output?.appendLine(`Base path set to ${this.basePath}`);
  }

  private _normalizePath(uri: vscode.Uri): string {
    let p = uri.path;
    if (this.basePath && p.startsWith(this.basePath)) {
      p = p.slice(this.basePath.length);
    }
    if (!p.startsWith('/')) {
      p = '/' + p;
    }
    return p;
  }

  private _normalizeUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({ authority: '', path: this._normalizePath(uri) });
  }

  private _pathWithoutRoot(uri: vscode.Uri): string {
    return this._normalizeUri(uri).path.replace(/^\/+/, '');
  }

  private _basename(uri: vscode.Uri): string {
    return this._pathWithoutRoot(uri).split('/').pop() || '';
  }

  setFilter(exts: string[]): void {
    this.allowedExts = new Set(exts.map((e) => e.toLowerCase()));
  }

  private async _ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.reload();
    }
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

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    this._ensureConnected(uri);
    this.output?.appendLine(
      `readDirectory ${uri.toString()} -> ${this._normalizePath(uri)}`,
    );
    await this._ensureLoaded();
    const entry = this._lookupAsDirectory(uri);
    return Array.from(entry.children).map(([name, child]) => [name, child.type]);
  }

  // readFile fetches content when a file is opened
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const file = this._lookupAsFile(uri);
    if (!file.id) {
      return new Uint8Array();
    }
    const conn = await this._getConnection();
    if (!conn) {
      throw vscode.FileSystemError.Unavailable('Not connected');
    }
    const { token, apiUrl } = conn;
    this.output?.appendLine(`Fetching ${uri.path}`);
    const url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset(${file.id})?$select=content`;
    const headers = { Authorization: `Bearer ${token}` };
    this.output?.appendLine(`GET ${url}`);
    this.output?.appendLine(
      `Request Headers: ${JSON.stringify({ Authorization: 'Bearer ***' })}`,
    );
    const resp = await fetch(url, { headers });
    this.output?.appendLine(`Response: ${resp.status}`);
    if (!resp.ok) {
      const body = await resp.text();
      this.output?.appendLine(`Failed to fetch ${uri.path}: ${resp.status} ${body}`);
      throw vscode.FileSystemError.Unavailable(`Failed to fetch ${uri.path}`);
    }
    const json = await resp.json();
    const base64 = (json.content as string | undefined) ?? '';
    if (!base64) {
      return new Uint8Array();
    }
    return Buffer.from(base64, 'base64');
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    this._ensureConnected(uri);
    const conn = await this._getConnection();
    if (!conn) {
      throw vscode.FileSystemError.Unavailable('Not connected');
    }
    const { token, apiUrl } = conn;
    const existing = this._lookup(uri);
    const data = Buffer.from(content).toString('base64');
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (existing && existing.type === vscode.FileType.File) {
      if (existing.id) {
        if (data.length === 0) {
          // skip updating empty content
        } else {
          const url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset(${existing.id})`;
          this.output?.appendLine(`PATCH ${url}`);
          const bodyData = { content: data };
          this.output?.appendLine(`Request Body: ${JSON.stringify(bodyData)}`);
          const resp = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(bodyData),
          });
          this.output?.appendLine(`Response: ${resp.status}`);
          if (!resp.ok) {
            const body = await resp.text();
            this.output?.appendLine(`Failed to update ${uri.path}: ${resp.status} ${body}`);
            throw vscode.FileSystemError.Unavailable(`Failed to update ${uri.path}`);
          }
        }
        } else if (data.length > 0) {
          const name = this._pathWithoutRoot(uri);
        const type = this._getTypeFromExtension(name);
        const url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset`;
        this.output?.appendLine(`POST ${url}`);
        const bodyData = {
          name,
          displayname: name,
          webresourcetype: type,
          content: data,
        };
        this.output?.appendLine(`Request Body: ${JSON.stringify(bodyData)}`);
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyData),
        });
        this.output?.appendLine(`Response: ${resp.status}`);
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
        if (!id) {
          const entityId =
            resp.headers.get('OData-EntityId') ||
            resp.headers.get('odata-entityid') ||
            resp.headers.get('Location');
          const match = entityId ? /\(([^)]+)\)/.exec(entityId) : null;
          if (match) {
            id = match[1];
          }
        }
        existing.id = id;
      }
    } else if (!existing && options.create) {
      const name = this._pathWithoutRoot(uri);
      if (data.length === 0) {
        this._addEntry(name);
      } else {
        const type = this._getTypeFromExtension(name);
        const url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset`;
        this.output?.appendLine(`POST ${url}`);
        const bodyData = {
          name,
          displayname: name,
          webresourcetype: type,
          content: data,
        };
        this.output?.appendLine(`Request Body: ${JSON.stringify(bodyData)}`);
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyData),
        });
        this.output?.appendLine(`Response: ${resp.status}`);
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
        if (!id) {
          const entityId =
            resp.headers.get('OData-EntityId') ||
            resp.headers.get('odata-entityid') ||
            resp.headers.get('Location');
          const match = entityId ? /\(([^)]+)\)/.exec(entityId) : null;
          if (match) {
            id = match[1];
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
    this._ensureConnected(uri);
    const parts = this._pathWithoutRoot(uri).split('/');
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
    this._ensureConnected(uri);
    const entry = this._lookup(uri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry.type === vscode.FileType.File) {
      const conn = await this._getConnection();
      if (!conn) {
        throw vscode.FileSystemError.Unavailable('Not connected');
      }
      const { token, apiUrl } = conn;
      if (entry.id) {
        const url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset(${entry.id})`;
        this.output?.appendLine(`DELETE ${url}`);
        const resp = await fetch(url, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        this.output?.appendLine(`Response: ${resp.status}`);
        if (!resp.ok) {
          const body = await resp.text();
          this.output?.appendLine(`Failed to delete ${uri.path}: ${resp.status} ${body}`);
          throw vscode.FileSystemError.Unavailable(`Failed to delete ${uri.path}`);
        }
        await this._publish(entry.id);
      }
    }
      const parent = vscode.Uri.joinPath(uri, '..');
      const parentEntry = this._lookupAsDirectory(parent);
      parentEntry.children.delete(this._basename(uri));
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    this._ensureConnected(oldUri);
    const entry = this._lookup(oldUri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }
    if (!options.overwrite && this._lookup(newUri)) {
      throw vscode.FileSystemError.FileExists(newUri);
    }
    if (entry.type === vscode.FileType.File) {
      const name = this._pathWithoutRoot(newUri);
      if (entry.id) {
        const conn = await this._getConnection();
        if (conn) {
          entry.id = await this._recreateWithNewName(
            entry,
            this._pathWithoutRoot(oldUri),
            name,
          );
        }
      }
      const parentOld = this._lookupAsDirectory(vscode.Uri.joinPath(oldUri, '..'));
      parentOld.children.delete(this._basename(oldUri));
      this._addEntry(name, entry.id);
    } else {
      const confirm = await vscode.window.showWarningMessage(
        `Rename folder ${oldUri.path} and all contained files?`,
        { modal: true },
        'Yes',
      );
      if (confirm !== 'Yes') {
        return;
      }
      const oldPath = this._pathWithoutRoot(oldUri);
      const newPath = this._pathWithoutRoot(newUri);
      await this._renameFolderEntries(entry as DirEntry, oldPath, newPath);

      const oldParent = this._lookupAsDirectory(vscode.Uri.joinPath(oldUri, '..'));
      const child = oldParent.children.get(this._basename(oldUri));
      if (!child) {
        throw vscode.FileSystemError.FileNotFound(oldUri);
      }
      oldParent.children.delete(this._basename(oldUri));
      const newParent = this._lookupAsDirectory(vscode.Uri.joinPath(newUri, '..'));
      newParent.children.set(this._basename(newUri), child);
      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    }
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, oldUri, newUri } as any]);
  }

  private async _fetchResources(): Promise<number> {
    if (!this.rootUri) {
      return 0;
    }
    const conn = await this._getConnection();
    if (!conn) {
      return 0;
    }
    const { token, apiUrl } = conn;
    this.root.children.clear();
    this.output?.appendLine(`Loading web resources from ${apiUrl}`);
    this.output?.appendLine(`Root URI ${this.rootUri.toString()} basePath ${this.basePath}`);

    let count = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading web resources...' },
      async () => {
        let url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset?$select=webresourceid,name`;
        const headers = { Authorization: `Bearer ${token}` };
        while (url) {
          this.output?.appendLine(`GET ${url}`);
          this.output?.appendLine(
            `Request Headers: ${JSON.stringify({ Authorization: 'Bearer ***' })}`,
          );
          const resp = await fetch(url, { headers });
          this.output?.appendLine(`Response: ${resp.status}`);
          if (!resp.ok) {
            const body = await resp.text();
            this.output?.appendLine(`Failed to list webresources: ${resp.status} ${body}`);
            throw new Error(`Failed to list webresources: ${resp.status}`);
          }
          const json = await resp.json();
          for (const item of json.value as { webresourceid: string; name: string }[]) {
            if (this._isExcluded(item.name) || !this._isAllowed(item.name)) {
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
    return count;
  }

  async reload(): Promise<number> {
    if (!this.rootUri) {
      const folder = vscode.workspace.workspaceFolders?.find(
        (f) => f.uri.scheme === 'd365-nwrm',
      );
      if (folder) {
        this._ensureConnected(folder.uri);
      }
    }
    if (!this.rootUri) {
      return 0;
    }
    const count = await this._fetchResources();
    this.loaded = true;
    return count;
  }

  private _isExcluded(name: string): boolean {
    return /^(msdyn_|mscrm_|adx_|microsoft)/i.test(name);
  }

  private _isAllowed(name: string): boolean {
    if (this.allowedExts.size === 0) {
      return true;
    }
    const ext = path.extname(name).toLowerCase();
    return this.allowedExts.has(ext);
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
    this._ensureConnected(uri);
    const norm = this._normalizePath(uri);
    if (norm === '/' || norm === '') {
      return this.root;
    }
    const parts = norm.split('/').slice(1);
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
    const ext = path.extname(name).toLowerCase();
    switch (ext) {
      case '.htm':
      case '.html':
        return 1;
      case '.css':
        return 2;
      case '.js':
        return 3;
      case '.xml':
        return 4;
      case '.png':
        return 5;
      case '.jpg':
      case '.jpeg':
        return 6;
      case '.gif':
        return 7;
      case '.xap':
        return 8;
      case '.xsl':
      case '.xslt':
        return 9;
      case '.ico':
        return 10;
      case '.svg':
        return 11;
      case '.resx':
        return 12;
      default:
        return 1;
    }
  }

  private async _recreateWithNewName(entry: FileEntry, oldName: string, newName: string): Promise<string | undefined> {
    if (!entry.id) {
      return entry.id;
    }
    const conn = await this._getConnection();
    if (!conn) {
      return entry.id;
    }
    const { token, apiUrl } = conn;

    const headers = { Authorization: `Bearer ${token}` };

    const getUrl = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset(${entry.id})?$select=content,webresourcetype`;
    this.output?.appendLine(`GET ${getUrl}`);
    const getResp = await fetch(getUrl, { headers });
    this.output?.appendLine(`Response: ${getResp.status}`);
    if (!getResp.ok) {
      const body = await getResp.text();
      this.output?.appendLine(`Failed to fetch ${oldName}: ${getResp.status} ${body}`);
      throw vscode.FileSystemError.Unavailable(`Failed to fetch ${oldName}`);
    }
    const json = await getResp.json();
    const content = json.content as string;
    const type = json.webresourcetype as number ?? this._getTypeFromExtension(oldName);

    const postUrl = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset`;
    this.output?.appendLine(`POST ${postUrl}`);
    const bodyData = { name: newName, displayname: newName, webresourcetype: type, content };
    this.output?.appendLine(`Request Body: ${JSON.stringify(bodyData)}`);
    const postResp = await fetch(postUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData),
    });
    this.output?.appendLine(`Response: ${postResp.status}`);
    const rawHeaders: Record<string, string> = {};
    postResp.headers.forEach((v, k) => {
      rawHeaders[k] = v;
    });
    const text = await postResp.text();
    this.output?.appendLine(`Response Headers: ${JSON.stringify(rawHeaders)}`);
    this.output?.appendLine(`Response Body: ${text}`);
    if (!postResp.ok) {
      this.output?.appendLine(`Failed to create ${newName}: ${postResp.status} ${text}`);
      throw vscode.FileSystemError.Unavailable(`Failed to create ${newName}`);
    }
    let newId: string | undefined;
    if (text) {
      try {
        newId = JSON.parse(text).webresourceid as string;
      } catch {
        /* ignore */
      }
    }
    if (!newId) {
      const entityId =
        postResp.headers.get('OData-EntityId') || postResp.headers.get('odata-entityid') || postResp.headers.get('Location');
      const match = entityId ? /\(([^)]+)\)/.exec(entityId) : null;
      if (match) {
        newId = match[1];
      }
    }

    const delUrl = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/webresourceset(${entry.id})`;
    this.output?.appendLine(`DELETE ${delUrl}`);
    const delResp = await fetch(delUrl, { method: 'DELETE', headers });
    this.output?.appendLine(`Response: ${delResp.status}`);
    if (!delResp.ok) {
      const body = await delResp.text();
      this.output?.appendLine(`Failed to delete ${oldName}: ${delResp.status} ${body}`);
      throw vscode.FileSystemError.Unavailable(`Failed to delete ${oldName}`);
    }

    await this._publish(newId);
    return newId;
  }

  private async _renameFolderEntries(entry: DirEntry, oldPrefix: string, newPrefix: string): Promise<void> {
    for (const [name, child] of entry.children) {
      const oldPath = `${oldPrefix}/${name}`;
      const newPath = `${newPrefix}/${name}`;
      if (child.type === vscode.FileType.File) {
        if (child.id) {
          const conn = await this._getConnection();
          if (conn) {
            child.id = await this._recreateWithNewName(child, oldPath, newPath);
          }
        }
      } else {
        await this._renameFolderEntries(child, oldPath, newPath);
      }
    }
  }

  private async _publish(id?: string): Promise<void> {
    if (!id) {
      return;
    }
    const conn = await this._getConnection();
    if (!conn) {
      return;
    }
    const { token, apiUrl } = conn;
    const xml = `<importexportxml><webresources><webresource>${id}</webresource></webresources></importexportxml>`;
    const url = `${apiUrl.replace(/\/?$/, '')}/api/data/v9.2/PublishXml`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ParameterXml: xml }),
    });
  }
}
