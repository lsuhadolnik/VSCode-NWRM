import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest } from '@azure/msal-node';
import fetch from 'node-fetch';
import * as path from 'path';
import * as dotenv from 'dotenv';

export function activate(context: vscode.ExtensionContext) {
  // Load environment variables from .env packaged with the extension
  dotenv.config({ path: path.join(context.extensionPath, '.env') });

  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    const token = await login(context);
    if (token) {
      const instances = await listInstances(token);
      await promptForInstance(context, instances);
    }
  });

  context.subscriptions.push(disposable);
}

async function login(context: vscode.ExtensionContext): Promise<string | undefined> {
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
    deviceCodeCallback: (response) => {
      if (response.verificationUri) {
        vscode.env.openExternal(vscode.Uri.parse(response.verificationUri));
      }
      vscode.window.showInformationMessage(response.message);
    }
  };

  try {
    const result = await pca.acquireTokenByDeviceCode(request);
    if (!result) {
      throw new Error('No token returned');
    }
    await context.globalState.update('accessToken', result.accessToken);
    vscode.window.showInformationMessage('Signed in to Dynamics CRM');
    return result.accessToken;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to sign in: ${err}`);
    return undefined;
  }
}

interface DiscoveryInstance {
  UniqueName: string;
  UrlName: string;
  FriendlyName?: string;
  WebUrl?: string;
}

async function listInstances(accessToken: string): Promise<DiscoveryInstance[]> {
  const resp = await fetch(
    'https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances?api-version=9.1',
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to query discovery service: ${resp.status}`);
  }
  const json = (await resp.json()) as { value: DiscoveryInstance[] };
  return json.value;
}

async function promptForInstance(
  context: vscode.ExtensionContext,
  instances: DiscoveryInstance[]
): Promise<void> {
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
  }
}

export function deactivate() {}
