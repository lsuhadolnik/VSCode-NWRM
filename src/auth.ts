import * as vscode from 'vscode';
import { PublicClientApplication, DeviceCodeRequest, AuthenticationResult, AccountInfo } from '@azure/msal-node';
import fetch from 'node-fetch';

export interface AuthResult {
  pca: PublicClientApplication;
  result: AuthenticationResult;
}

export interface DiscoveryInstance {
  ApiUrl: string;
  UniqueName: string;
  UrlName: string;
  FriendlyName?: string;
  Url?: string;
}

export async function login(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<AuthResult | undefined> {
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
        [{ label: response.userCode, description: 'Press Enter to copy the code and open the browser' }],
        { placeHolder: 'A browser window will open for sign in' }
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

export async function acquireTokenForResource(
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
          [{ label: response.userCode, description: 'Press Enter to copy the code and open the browser' }],
          { placeHolder: 'A browser window will open for sign in' }
        );
        if (pick && response.verificationUri) {
          await vscode.env.clipboard.writeText(response.userCode);
          vscode.env.openExternal(vscode.Uri.parse(response.verificationUri));
          vscode.window.showInformationMessage('Device code copied to clipboard.');
        }
      }
    };
    const result = await pca.acquireTokenByDeviceCode(request);
    if (!result) {
      throw new Error('No token returned');
    }
    return result;
  }
}

export async function saveConnection(
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
