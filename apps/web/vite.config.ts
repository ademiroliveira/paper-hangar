import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// GitHub Pages serves the site from /paper-hangar/. Override with BASE=/ for other hosts.
export default defineConfig({
  base: process.env.BASE ?? '/paper-hangar/',
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: [root] } },
});
