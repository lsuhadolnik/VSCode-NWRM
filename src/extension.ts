import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest } from '@azure/msal-node';
import * as path from 'path';
import * as dotenv from 'dotenv';

export function activate(context: vscode.ExtensionContext) {
  // Load environment variables from .env packaged with the extension
  dotenv.config({ path: path.join(context.extensionPath, '.env') });

  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    await login(context);
  });

  context.subscriptions.push(disposable);
}

async function login(context: vscode.ExtensionContext): Promise<void> {
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
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to sign in: ${err}`);
  }
}

export function deactivate() {}
