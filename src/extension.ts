import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest, AuthenticationResult, AccountInfo } from '@azure/msal-node';
import fetch from 'node-fetch';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { CrmFileSystemProvider } from './crmFs';
import { ConnectionsProvider, EnvironmentItem } from './connections';

interface AuthResult {
  pca: PublicClientApplication;
  result: AuthenticationResult;
}

async function tryLoadFolder(
  context: vscode.ExtensionContext,
  fsProvider: CrmFileSystemProvider,
  connectionsProvider: ConnectionsProvider,
  output: vscode.OutputChannel,
) {
  const folder = vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.scheme === 'd365-nwrm',
  );
  if (!folder) {
    return;
  }
  const host = folder.uri.authority;
  if (!host) {
    return;
  }
  const saved =
    context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
  const instance = saved[host];
  if (!instance) {
    output.appendLine(`No saved environment for ${host}`);
    return;
  }

  let token = await context.secrets.get(`token:${host}`);
  let expiry = context.globalState.get<number>(`tokenExpires:${host}`) ?? 0;
  if (!token || expiry <= Date.now()) {
    output.appendLine(`Token for ${host} missing or expired. Reauthenticating...`);
    const auth = await login(context, output);
    if (!auth || !auth.result.account) {
      vscode.window.showErrorMessage('Sign in required to open environment');
      return;
    }
    const envToken = await acquireTokenForResource(
      auth.pca,
      auth.result.account,
      instance.ApiUrl,
      output,
    );
    token = envToken.accessToken;
    expiry = envToken.expiresOn?.getTime() ?? Date.now() + 3600 * 1000;
    await saveConnection(
      context,
      instance,
      token,
      envToken.expiresOn ?? new Date(expiry),
      auth.result.account.username,
    );
  }

  fsProvider.connect(token, instance.ApiUrl, folder.uri);
  connectionsProvider.refresh();
}

export async function activate(context: vscode.ExtensionContext) {
  // Load environment variables from .env packaged with the extension
  dotenv.config({ path: path.join(context.extensionPath, '.env') });

  const output = vscode.window.createOutputChannel('Dynamics CRM');
  const fsProvider = new CrmFileSystemProvider(output);
  const connectionsProvider = new ConnectionsProvider(context);

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

  await tryLoadFolder(context, fsProvider, connectionsProvider, output);
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


async function saveConnection(
  context: vscode.ExtensionContext,
  instance: DiscoveryInstance,
  token: string,
  expires: Date,
  account: string
): Promise<void> {
  const host = new URL(instance.ApiUrl).host;
  await context.secrets.store(`token:${host}`, token);
  await context.globalState.update(`tokenExpires:${host}`, expires.getTime());
  const saved = context.globalState.get<Record<string, DiscoveryInstance>>('savedEnvironments') ?? {};
  saved[host] = instance;
  await context.globalState.update('savedEnvironments', saved);
  await context.globalState.update(`savedAccount:${host}`, account);
}

export function deactivate() {}
