# AGENT Instructions

This repository contains a VS Code extension written in TypeScript.

## Testing and Building

- Always run `npm run build` after changing any files under `src` or the build configuration.
- Run `npm test` after building to ensure the extension compiles correctly. The test script currently executes the build as a sanity check.

## Environment Configuration

- Client IDs used for authentication should be placed in a `.env` file at the extension root.
- `.env` is ignored by git; copy `.env.example` when setting up the project.

## Coding Conventions

- Use TypeScript for all source files located in `src/`.
- Keep commits focused and descriptive.

