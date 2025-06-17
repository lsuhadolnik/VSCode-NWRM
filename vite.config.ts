import { defineConfig } from 'vite';
import { builtinModules } from 'module';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.js'
    },
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      external: ['vscode', ...builtinModules]
    }
  }
});
