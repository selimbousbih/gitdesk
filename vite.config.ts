import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'gitdesk-development-csp',
      apply: 'serve',
      // React Refresh injects a small inline preamble; the packaged app never permits it.
      transformIndexHtml: (html) => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
    },
  ],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: true },
});
