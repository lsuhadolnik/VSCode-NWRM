import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest } from '@azure/msal-node';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    await login(context);
  });

  context.subscriptions.push(disposable);
}

async function login(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('dynamicsCrm');
  const clientId = config.get<string>('clientId');
  if (!clientId) {
    vscode.window.showErrorMessage('Set dynamicsCrm.clientId in your settings.');
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
      vscode.window.showInformationMessage(response.message);
    }
  };

  try {
    const result = await pca.acquireTokenByDeviceCode(request);
    await context.globalState.update('accessToken', result.accessToken);
    vscode.window.showInformationMessage('Signed in to Dynamics CRM');
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to sign in: ${err}`);
  }
}

export function deactivate() {}
