
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'assets',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'ui', 'Panel.tsx'),
      formats: ['es'],
      fileName: () => 'panel.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || '';
          if (name === 'style.css' || name.endsWith('.css')) return 'panel.css';
          return '[name][extname]';
        },
      },
    },
  },
});
