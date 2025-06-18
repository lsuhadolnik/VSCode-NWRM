import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest, AuthenticationResult, AccountInfo } from '@azure/msal-node';
import fetch from 'node-fetch';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as dotenv from 'dotenv';
import { CrmFileSystemProvider } from './crmFs';
import { ConnectionsProvider, ConnectionItem } from './connections';

interface AuthResult {
  pca: PublicClientApplication;
  result: AuthenticationResult;
}

export async function activate(context: vscode.ExtensionContext) {
  // Load environment variables from .env packaged with the extension
  dotenv.config({ path: path.join(context.extensionPath, '.env') });

  const output = vscode.window.createOutputChannel('Dynamics CRM');
  const fsProvider = new CrmFileSystemProvider(output);
  const connectionsProvider = new ConnectionsProvider(context);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('crm', fsProvider, { isReadonly: true })
  );

  vscode.window.registerTreeDataProvider('connections', connectionsProvider);

  // Load pending connection if we were launched with a CRM workspace
  const pendingInstance = context.globalState.get<DiscoveryInstance>('pendingInstance');
  const pendingExpiry = context.globalState.get<number>('pendingExpires');
  if (pendingInstance) {
    const applyConnection = async () => {
      const token = await context.secrets.get('pendingToken');
      if (token && pendingExpiry && pendingExpiry > Date.now()) {
        await fsProvider.load(token, pendingInstance.ApiUrl);
        vscode.workspace.updateWorkspaceFolders(
          0,
          vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
          {
            uri: vscode.Uri.parse('crm:/'),
            name: `${pendingInstance.FriendlyName ?? pendingInstance.UniqueName} (${new URL(pendingInstance.ApiUrl).host})`
          }
        );
      }
      await context.secrets.delete('pendingToken');
      await context.globalState.update('pendingInstance', undefined);
      await context.globalState.update('pendingExpires', undefined);
    };

    if (vscode.workspace.isTrusted) {
      await applyConnection();
    } else {
      const disposableTrust = vscode.workspace.onDidGrantWorkspaceTrust(async () => {
        await applyConnection();
        disposableTrust.dispose();
      });
    }
  }

  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    const auth = await login(context, output);
    if (auth) {
      const { pca, result } = auth;
      const discoveryToken = result.accessToken;
      const instances = await listInstances(discoveryToken, output);
      const instance = await promptForInstance(context, instances);
      if (instance && result.account) {
        const envTokenResult = await acquireTokenForResource(
          pca,
          result.account,
          instance.ApiUrl,
          output
        );
        const token = envTokenResult.accessToken;
        const tokenExpires = envTokenResult.expiresOn ?? new Date(Date.now() + 3600 * 1000);
        await saveConnection(context, instance, token, tokenExpires);
        await context.secrets.store('pendingToken', token);
        await context.globalState.update('pendingInstance', instance);
        await context.globalState.update('pendingExpires', tokenExpires.getTime());

        const workspacePath = path.join(context.globalStorageUri.fsPath, 'crm.code-workspace');
        await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
        const workspaceContent = JSON.stringify({ folders: [{ uri: 'crm:/' }] }, null, 2);
        await fs.writeFile(workspacePath, workspaceContent);
        connectionsProvider.refresh();
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath), true);
      }
    }
  });

  const connectSavedCmd = vscode.commands.registerCommand('dynamicsCrm.connectSaved', async (item: ConnectionItem) => {
    const token = await context.secrets.get(`token:${item.instance.UrlName}`);
    const expiry = context.globalState.get<number>(`tokenExpires:${item.instance.UrlName}`) ?? 0;
    if (!token || expiry <= Date.now()) {
      vscode.window.showErrorMessage('Saved token has expired.');
      return;
    }
    await context.secrets.store('pendingToken', token);
    await context.globalState.update('pendingInstance', item.instance);
    await context.globalState.update('pendingExpires', expiry);

    const workspacePath = path.join(context.globalStorageUri.fsPath, 'crm.code-workspace');
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    const workspaceContent = JSON.stringify({ folders: [{ uri: 'crm:/' }] }, null, 2);
    await fs.writeFile(workspacePath, workspaceContent);

    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath), true);
  });

  const deleteTokenCmd = vscode.commands.registerCommand('dynamicsCrm.deleteToken', async (item: ConnectionItem) => {
    await context.secrets.delete(`token:${item.instance.UrlName}`);
    await context.globalState.update(`tokenExpires:${item.instance.UrlName}`, undefined);
    const saved = context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
    delete saved[item.instance.UrlName];
    await context.globalState.update('savedEnvironments', saved);
    connectionsProvider.refresh();
  });

  context.subscriptions.push(disposable, connectSavedCmd, deleteTokenCmd, output);
}


async function login(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<AuthResult | undefined> {
  const config = vscode.workspace.getConfiguration('dynamicsCrm');
  const envClientId = process.env.DYNAMICS_CRM_CLIENT_ID;
  const clientId = envClientId ?? config.get<string>('clientId');
  if (!clientId) {
    vscode.window.showErrorMessage('Set DYNAMICS_CRM_CLIENT_ID in .env or dynamicsCrm.clientId in your settings.');
    return;
  }

  const pca = new PublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/common'
    }
  });

  const request: DeviceCodeRequest = {
    scopes: ['https://globaldisco.crm.dynamics.com/.default'],
    deviceCodeCallback: async (response) => {
      output.appendLine(`Device code: ${response.userCode}`);
      output.appendLine(`Verification URL: ${response.verificationUri}`);
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: response.userCode,
            description: 'Press Enter to copy the code and open the browser'
          }
        ],
        {
          placeHolder: 'A browser window will open for sign in'
        }
      );
      if (pick && response.verificationUri) {
        await vscode.env.clipboard.writeText(response.userCode);
        vscode.env.openExternal(vscode.Uri.parse(response.verificationUri));
        vscode.window.showInformationMessage('Device code copied to clipboard.');
      }
    }
  };

  try {
    output.appendLine('Starting device code authentication...');
    const result = await pca.acquireTokenByDeviceCode(request);
    if (!result) {
      throw new Error('No token returned');
    }
    await context.globalState.update('accessToken', result.accessToken);
    vscode.window.showInformationMessage('Signed in to Dynamics CRM');
    output.appendLine('Authentication successful.');
    return { pca, result };
  } catch (err: any) {
    output.appendLine(`Authentication failed: ${err}`);
    vscode.window.showErrorMessage(`Failed to sign in: ${err}`);
    return undefined;
  }
}

async function acquireTokenForResource(
  pca: PublicClientApplication,
  account: AccountInfo,
  resourceUrl: string,
  output: vscode.OutputChannel
): Promise<AuthenticationResult> {
  const scopes = [`${resourceUrl.replace(/\/?$/, '')}/.default`];
  try {
    output.appendLine(`Acquiring token silently for ${resourceUrl}`);
    const result = await pca.acquireTokenSilent({ account, scopes });
    if (!result) {
      throw new Error('No token returned');
    }
    return result;
  } catch (err) {
    output.appendLine(`Silent token acquisition failed: ${err}`);
    const request: DeviceCodeRequest = {
      scopes,
      deviceCodeCallback: async (response) => {
        output.appendLine(`Device code: ${response.userCode}`);
        output.appendLine(`Verification URL: ${response.verificationUri}`);
        const pick = await vscode.window.showQuickPick(
          [
            {
              label: response.userCode,
              description: 'Press Enter to copy the code and open the browser',
            },
          ],
          {
            placeHolder: 'A browser window will open for sign in',
          }
        );
        if (pick && response.verificationUri) {
          await vscode.env.clipboard.writeText(response.userCode);
          vscode.env.openExternal(vscode.Uri.parse(response.verificationUri));
          vscode.window.showInformationMessage('Device code copied to clipboard.');
        }
      },
    };
    const result = await pca.acquireTokenByDeviceCode(request);
    if (!result) {
      throw new Error('No token returned');
    }
    return result;
  }
}

export interface DiscoveryInstance {
  ApiUrl: string;
  UniqueName: string;
  UrlName: string;
  FriendlyName?: string;
  Url?: string;
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

async function promptForInstance(
  context: vscode.ExtensionContext,
  instances: DiscoveryInstance[]
): Promise<DiscoveryInstance | undefined> {
  const items = instances.map((i) => ({
    label: i.FriendlyName ?? i.UniqueName,
    description: i.UrlName,
    detail: i.ApiUrl,
    instance: i
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select Dynamics environment'
  });
  if (pick) {
    await context.globalState.update('selectedInstance', pick.instance.UrlName);
    vscode.window.showInformationMessage(`Selected ${pick.label}`);
    return pick.instance;
  }
  return undefined;
}

async function saveConnection(
  context: vscode.ExtensionContext,
  instance: DiscoveryInstance,
  token: string,
  expires: Date
): Promise<void> {
  await context.secrets.store(`token:${instance.UrlName}`, token);
  await context.globalState.update(`tokenExpires:${instance.UrlName}`, expires.getTime());
  const saved = context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
  saved[instance.UrlName] = instance;
  await context.globalState.update('savedEnvironments', saved);
}

export function deactivate() {}
