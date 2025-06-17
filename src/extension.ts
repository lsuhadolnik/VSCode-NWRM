import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('dynamicsCrm.connect', async () => {
    vscode.window.showInformationMessage('Connect to Dynamics CRM command executed.');
    // TODO: implement connection logic
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
