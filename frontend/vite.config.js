import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, '../public/react'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/main.jsx'),
      external: ['/app.js'],
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
