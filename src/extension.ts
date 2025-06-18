import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest } from '@azure/msal-node';
import fetch from 'node-fetch';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { CrmFileSystemProvider } from './crmFs';

export function activate(context: vscode.ExtensionContext) {
  // Load environment variables from .env packaged with the extension
  dotenv.config({ path: path.join(context.extensionPath, '.env') });

  const output = vscode.window.createOutputChannel('Dynamics CRM');
  const fsProvider = new CrmFileSystemProvider(output);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('crm', fsProvider, { isReadonly: true })
  );

  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    const token = await login(context, output);
    if (token) {
      const instances = await listInstances(token, output);
      const instance = await promptForInstance(context, instances);
      if (instance) {
        await fsProvider.load(token, instance.ApiUrl);
        vscode.workspace.updateWorkspaceFolders(0, 0, {
          uri: vscode.Uri.parse('crm:/'),
          name: instance.FriendlyName ?? instance.UniqueName
        });
      }
    }
  });

  context.subscriptions.push(disposable, output);
}

async function login(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string | undefined> {
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
    return result.accessToken;
  } catch (err: any) {
    output.appendLine(`Authentication failed: ${err}`);
    vscode.window.showErrorMessage(`Failed to sign in: ${err}`);
    return undefined;
  }
}

interface DiscoveryInstance {
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

export function deactivate() {}
