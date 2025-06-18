# Dynamics CRM Web Resources Manager VSCode Extension

This extension provides an integrated experience for managing Dynamics 365 (CRM) Web Resources directly from Visual Studio Code. It connects to your CRM instance, discovers all available environments and exposes Web Resources as virtual files in a read-only filesystem. You can open, edit, and save changes back to Dynamics without leaving VS Code.

## Features

- **Interactive authentication** – Sign in to your Dynamics CRM tenant and automatically discover all environments using the Discovery Service. After signing in, you're prompted to choose the environment to connect to. A prompt copies the device code to your clipboard and opens the login page for you.
- **Virtual file system** – Browse and edit Web Resources as regular files in a custom tree view.
- **Publish on save** – Press `Ctrl+S` to publish updates back to Dynamics CRM.
- **Sidebar integration** – A dedicated view allows you to connect to an environment and manage Web Resources.
- **Command Palette command** – Quickly connect to an environment from the Command Palette.

## Getting Started

This repository contains a TypeScript-based VSCode extension compiled using the TypeScript compiler (`tsc`).

### Prerequisites

- [Node.js](https://nodejs.org/) 16 or later
- [pnpm](https://pnpm.io/) or `npm`
- [VS Code](https://code.visualstudio.com/)

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Copy `.env.example` to `.env` and set `DYNAMICS_CRM_CLIENT_ID` to your Azure AD client ID.
4. Launch the extension in the Extension Development Host:
   ```bash
   code .
   ```
   Press `F5` in VS Code to start debugging.
   Once VS Code launches, run the **Dynamics CRM: Connect** command and choose
   the environment you want to work with. A notification will copy the device
   code to your clipboard and open the login page when you press **Enter**.
   If anything goes wrong during sign in or environment discovery, check the
   **Dynamics CRM** output channel for details.

### Azure App Registration

1. Sign in to the [Azure Portal](https://portal.azure.com/) and open **Azure Active Directory** > **App registrations**.
2. Create a **New registration** and choose the **Public client/native** platform.
3. Add `http://localhost` as a redirect URI.
4. In the **Authentication** tab, enable **Allow public client flows** to permit device code login.
5. Under **API permissions** add the **Dynamics CRM** delegated permission `user_impersonation` and grant admin consent if required.
6. Copy the **Application (client) ID** and set `DYNAMICS_CRM_CLIENT_ID` in your `.env` file.

The extension authenticates using the device code flow and does not require a client secret.

### Scripts

- `npm run build` – Compile the extension using TypeScript.
- `npm test` – Currently runs the build as a sanity check.
- `npm run watch` – Rebuild on file changes.

## Roadmap

This project currently contains only the initial scaffolding. Future work includes implementing the virtual file system provider, connecting to the Dynamics Discovery Service, listing environments, and publishing edited Web Resources.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
