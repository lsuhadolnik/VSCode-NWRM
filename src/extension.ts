import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { CrmFileSystemProvider } from './crmFs';
import { ConnectionsProvider, EnvironmentItem } from './connections';
import { login, acquireTokenForResource, saveConnection, DiscoveryInstance } from './auth';


export async function activate(context: vscode.ExtensionContext) {
  // Load environment variables from .env packaged with the extension
  dotenv.config({ path: path.join(context.extensionPath, '.env') });

  const output = vscode.window.createOutputChannel('Dynamics CRM');
  const connectionsProvider = new ConnectionsProvider(context);
  const fsProvider = new CrmFileSystemProvider(connectionsProvider, output);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('d365-nwrm', fsProvider, {
      isReadonly: false,
    })
  );

  vscode.window.registerTreeDataProvider('connections', connectionsProvider);


  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    const auth = await login(context, output);
    if (auth) {
      const { pca, result } = auth;
      const discoveryToken = result.accessToken;
      const instances = await listInstances(discoveryToken, output);
      if (result.account) {
        for (const instance of instances) {
          try {
            const envTokenResult = await acquireTokenForResource(
              pca,
              result.account,
              instance.ApiUrl,
              output
            );
            const token = envTokenResult.accessToken;
            const tokenExpires = envTokenResult.expiresOn ?? new Date(Date.now() + 3600 * 1000);
            await saveConnection(
              context,
              instance,
              token,
              tokenExpires,
              result.account.username
            );
          } catch (err: any) {
            output.appendLine(`Failed to acquire token for ${instance.ApiUrl}: ${err}`);
          }
        }
        vscode.window.showInformationMessage('Sign in successful. Open an environment from the Dynamics WebResource Manager view.');
        connectionsProvider.refresh();
      }
    }
  });


  const deleteTokenCmd = vscode.commands.registerCommand('dynamicsCrm.deleteToken', async (item: EnvironmentItem) => {
    const host = new URL(item.instance.ApiUrl).host;
    await context.secrets.delete(`token:${host}`);
    await context.globalState.update(`tokenExpires:${host}`, undefined);
    const saved = context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
    delete saved[host];
    await context.globalState.update('savedEnvironments', saved);
    connectionsProvider.refresh();
  });

  const addConnectionCmd = vscode.commands.registerCommand('dynamicsCrm.addConnection', async () => {
    vscode.commands.executeCommand('dynamicsCrm.connect');
  });

  const openEnvCmd = vscode.commands.registerCommand('dynamicsCrm.openEnvironment', async (item: EnvironmentItem) => {
    const pick = await vscode.window.showInformationMessage(
      `Open environment ${item.description}?`,
      { modal: true },
      'Open'
    );
    if (pick !== 'Open') {
      return;
    }
    await saveConnection(context, item.instance, item.token, item.expiresOn, item.account);
    const uri = vscode.Uri.parse(`d365-nwrm://${new URL(item.instance.ApiUrl).host}`);
    output.appendLine(`Opening folder ${uri.toString()}`);
    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
  });

  const publishCmd = vscode.commands.registerCommand(
    'dynamicsCrm.publishWebResource',
    async (resource?: vscode.Uri) => {
      let uri: vscode.Uri | undefined;
      if (resource instanceof vscode.Uri) {
        uri = resource;
      } else if (vscode.window.activeTextEditor) {
        uri = vscode.window.activeTextEditor.document.uri;
      }
      if (!uri || uri.scheme !== 'd365-nwrm') {
        vscode.window.showErrorMessage('No web resource selected');
        return;
      }
      try {
        await fsProvider.publish(uri);
        vscode.window.showInformationMessage(`Published ${uri.path}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to publish ${uri.path}: ${err}`);
      }
    },
  );

  const reloadCmd = vscode.commands.registerCommand('dynamicsCrm.reloadWebResources', async () => {
    const count = await fsProvider.reload();
    vscode.window.showInformationMessage(`Reloaded ${count} web resources`);
  });

  const filterCmd = vscode.commands.registerCommand('dynamicsCrm.filterTypes', async () => {
    const options = [
      { label: 'JavaScript', ext: '.js', picked: true },
      { label: 'HTML', ext: '.html', picked: true },
      { label: 'CSS', ext: '.css', picked: true },
    ];
    const picks = await vscode.window.showQuickPick(options, { canPickMany: true });
    if (!picks) {
      return;
    }
    fsProvider.setFilter(picks.map((p) => (p as any).ext));
    await fsProvider.reload();
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (doc.uri.scheme === 'd365-nwrm') {
      try {
        await fsProvider.publish(doc.uri);
        output.appendLine(`Auto-published ${doc.uri.path}`);
      } catch (err: any) {
        output.appendLine(`Auto-publish failed for ${doc.uri.path}: ${err}`);
      }
    }
  });

  context.subscriptions.push(
    disposable,
    deleteTokenCmd,
    addConnectionCmd,
    openEnvCmd,
    reloadCmd,
    filterCmd,
    publishCmd,
    saveListener,
    output,
  );
}


async function listInstances(accessToken: string, output: vscode.OutputChannel): Promise<DiscoveryInstance[]> {
  output.appendLine('Querying discovery service for environments...');
  const resp = await fetch(
    'https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances?$select=ApiUrl,FriendlyName,UniqueName,UrlName,Url',
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  if (!resp.ok) {
    const body = await resp.text();
    output.appendLine(`Discovery request failed: ${resp.status} ${body}`);
    throw new Error(`Failed to query discovery service: ${resp.status}`);
  }
  const json = (await resp.json()) as { value: DiscoveryInstance[] };
  output.appendLine(`Found ${json.value.length} environments.`);
  return json.value;
}


export function deactivate() {}
