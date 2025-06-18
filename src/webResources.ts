import * as vscode from 'vscode';
import { CrmFileSystemProvider } from './crmFs';

export class WebResourceItem extends vscode.TreeItem {
  constructor(public readonly uri: vscode.Uri, type: vscode.FileType) {
    super(uri.path.split('/').pop() || uri.path,
      type === vscode.FileType.Directory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    if (type === vscode.FileType.File) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Web Resource',
        arguments: [uri]
      };
    }
    this.contextValue = type === vscode.FileType.Directory ? 'folder' : 'file';
  }
}

export class WebResourcesProvider implements vscode.TreeDataProvider<WebResourceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WebResourceItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private fs: CrmFileSystemProvider) {
    fs.onDidChangeFile(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: WebResourceItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WebResourceItem): vscode.ProviderResult<WebResourceItem[]> {
    const uri = element ? element.uri : vscode.Uri.parse('crm:/');
    try {
      const entries = this.fs.readDirectory(uri);
      return entries.map(([name, type]) => new WebResourceItem(vscode.Uri.joinPath(uri, name), type));
    } catch {
      return [];
    }
  }
}
