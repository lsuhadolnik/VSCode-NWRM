import * as vscode from 'vscode';
import { DiscoveryInstance } from './extension';

export class AccountItem extends vscode.TreeItem {
  constructor(public readonly account: string) {
    super(account, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'account';
  }
}

export class EnvironmentItem extends vscode.TreeItem {
  constructor(
    public readonly instance: DiscoveryInstance,
    public readonly token: string,
    public readonly expiresOn: Date,
    public readonly account: string,
  ) {
    super(instance.FriendlyName ?? instance.UniqueName, vscode.TreeItemCollapsibleState.None);
    this.description = new URL(instance.ApiUrl).host;
    this.contextValue = 'environment';
    this.command = {
      command: 'dynamicsCrm.openEnvironment',
      title: 'Open Environment',
      arguments: [this],
    };
  }
}

export class ConnectionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const saved = this.context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
    if (!element) {
      const accounts = new Set<string>();
      for (const key of Object.keys(saved)) {
        const account = this.context.globalState.get<string>(`savedAccount:${key}`);
        if (account) {
          accounts.add(account);
        }
      }
      return Array.from(accounts).map((a) => new AccountItem(a));
    }

    if (element instanceof AccountItem) {
      const items: EnvironmentItem[] = [];
      for (const [host, instance] of Object.entries(saved)) {
        const account = this.context.globalState.get<string>(`savedAccount:${host}`);
        if (account !== element.account) {
          continue;
        }
        const expiry = this.context.globalState.get<number>(`tokenExpires:${host}`);
        if (!expiry || expiry <= Date.now()) {
          continue;
        }
        const token = await this.context.secrets.get(`token:${host}`);
        if (!token) {
          continue;
        }
        items.push(new EnvironmentItem(instance, token, new Date(expiry), account));
      }
      return items;
    }

    return [];
  }
}
