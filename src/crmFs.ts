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
  id: string;
}
type Entry = DirEntry | FileEntry;

export class CrmFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

  private root: DirEntry = { type: vscode.FileType.Directory, children: new Map() };
  private accessToken?: string;
  private apiUrl?: string;

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
      size: 0
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const entry = this._lookupAsDirectory(uri);
    return Array.from(entry.children).map(([name, child]) => [name, child.type]);
  }

  // readFile fetches content when a file is opened
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const file = this._lookupAsFile(uri);
    if (!this.accessToken || !this.apiUrl) {
      throw vscode.FileSystemError.Unavailable('Not connected');
    }
    const resp = await fetch(
      `${this.apiUrl}/api/data/v9.2/webresourceset(${file.id})?$select=content`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      }
    );
    if (!resp.ok) {
      throw vscode.FileSystemError.Unavailable(`Failed to fetch ${uri.path}`);
    }
    const json = await resp.json();
    const base64 = json.content as string;
    return Buffer.from(base64, 'base64');
  }

  // unused write operations
  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  async load(accessToken: string, apiUrl: string): Promise<void> {
    this.accessToken = accessToken;
    this.apiUrl = apiUrl.replace(/\/?$/, '');
    this.root.children.clear();

    let url = `${this.apiUrl}/api/data/v9.2/webresourceset?$select=webresourceid,name`;
    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      if (!resp.ok) {
        throw new Error(`Failed to list webresources: ${resp.status}`);
      }
      const json = await resp.json();
      for (const item of json.value as { webresourceid: string; name: string }[]) {
        if (this._isExcluded(item.name)) {
          continue;
        }
        this._addEntry(item.name, item.webresourceid);
      }
      url = json['@odata.nextLink'];
    }
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.parse('crm:/') }]);
  }

  private _isExcluded(name: string): boolean {
    return /^(msdyn_|mscrm_|adx_|microsoft)/i.test(name);
  }

  private _addEntry(resourceName: string, id: string): void {
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
}
