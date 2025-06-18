import * as vscode from 'vscode';
import { DiscoveryInstance } from './extension';

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    public readonly instance: DiscoveryInstance,
    public readonly token: string,
    public readonly expiresOn: Date
  ) {
    super(instance.FriendlyName ?? instance.UniqueName, vscode.TreeItemCollapsibleState.None);
    this.description = instance.UrlName;
    this.contextValue = 'connection';
    this.command = {
      command: 'dynamicsCrm.connectSaved',
      title: 'Connect',
      arguments: [this]
    };
  }
}

export class ConnectionsProvider implements vscode.TreeDataProvider<ConnectionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConnectionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ConnectionItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ConnectionItem[]> {
    const saved = this.context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
    const items: ConnectionItem[] = [];
    for (const [urlName, instance] of Object.entries(saved)) {
      const expiry = this.context.globalState.get<number>(`tokenExpires:${urlName}`);
      if (!expiry || expiry <= Date.now()) {
        continue; // skip expired tokens
      }
      const token = await this.context.secrets.get(`token:${urlName}`);
      if (!token) {
        continue;
      }
      items.push(new ConnectionItem(instance, token, new Date(expiry)));
    }
    return items;
  }
}
