import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import { version } from './package.json';

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: 'Dolly',
    // Taken from package.json, which also names the release zip, so the
    // installed extension and the file it came from can never disagree.
    version,
    description: 'Cinematic product demos in the browser',
    action: {
      default_title: 'Dolly',
    },
    permissions: [
      'storage',
      'debugger',
      'tabs',
      'scripting',
    ],
    host_permissions: ['<all_urls>'],
  },
});
