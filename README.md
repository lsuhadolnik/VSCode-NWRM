# Dynamics CRM Web Resources Manager VSCode Extension

This extension provides an integrated experience for managing Dynamics 365 (CRM) Web Resources directly from Visual Studio Code. It connects to your CRM instance, discovers all available environments and exposes Web Resources as virtual files in a read-only filesystem. You can open, edit, and save changes back to Dynamics without leaving VS Code.

## Features

- **Interactive authentication** – Sign in to your Dynamics CRM tenant and automatically discover all environments using the Discovery Service. After signing in, you're prompted to choose the environment to connect to. A prompt copies the device code to your clipboard and opens the login page for you.
- **Virtual file system** – Browse and edit Web Resources as regular files in a custom tree view.
- **Publish on save** – Press `Ctrl+S` to publish updates back to Dynamics CRM.
- **Sidebar integration** – A dedicated view allows you to connect to an environment and manage Web Resources.
- **Command Palette command** – Quickly connect to an environment from the Command Palette.
- **Web Resource Manager sidebar** – Reuse stored tokens to reconnect to previous environments and delete them when no longer needed.
- **Separate workspace per environment** – After choosing an environment, a new window opens with the Web Resources loaded so the original window stays untouched.

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
3. Extension icons are stored in the `images/` folder. The activity bar icon uses a 20x20 SVG (`images/webresource.svg`). Replace it with your own if desired.
4. Copy `.env.example` to `.env` and set `DYNAMICS_CRM_CLIENT_ID` to your Azure AD client ID.
5. Launch the extension in the Extension Development Host:
   ```bash
   code .
   ```
   Press `F5` in VS Code to start debugging.
   Once VS Code launches, run the **Dynamics CRM: Connect** command and choose
   the environment you want to work with. A quick pick displays the device code
   and copies it to your clipboard, opening the login page when you press
  **Enter**.
  If anything goes wrong during sign in or environment discovery, check the
  **Dynamics CRM** output channel for details.
  You can open the output view with `Ctrl+Shift+U` (View → Output) and choose
  **Dynamics CRM** from the channel dropdown to see detailed logs, including web
  resource load errors. Each HTTP request is logged with headers to make
  troubleshooting authentication problems easier.
  Saved connections with valid tokens appear in the **Web Resource Manager** sidebar so you can quickly reconnect or remove them.
  After selecting an environment, the extension acquires a separate access token scoped to that instance to avoid 401 errors caused by an invalid audience.
  A new VS Code window opens with a workspace containing your Web Resources so the original window remains clean.

### Environment Discovery

The extension retrieves available environments using the [Global Discovery Service](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/discovery-service).
It issues the following request to list instances:

```http
GET https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances?$select=ApiUrl,FriendlyName,UniqueName,UrlName,Url HTTP/1.1
Authorization: Bearer <access token>
```

The response contains environment metadata used to populate the quick pick menu.

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
