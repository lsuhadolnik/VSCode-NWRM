import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    sourcemap: true,
    target: 'node18',
    outDir: 'dist',
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.js',
    },
    rollupOptions: {
      external: [
        'vscode',
        '@azure/msal-node',
        'dotenv',
        'path',
        'fs',
      ],
    },
  },
});
