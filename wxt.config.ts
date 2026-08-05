import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: 'Dolly',
    description: 'Cinematic product demos in the browser',
    action: {
      default_title: 'Dolly',
    },
    permissions: [
      'storage',
      'debugger',
      'tabs',
      'scripting',
      'activeTab',
      'downloads',
      'declarativeNetRequest',
      'webNavigation',
    ],
    host_permissions: ['<all_urls>'],
    declarative_net_request: {
      rule_resources: [
        {
          id: 'dolly-frame',
          enabled: true,
          path: 'dnr_rules.json',
        },
      ],
    },
  },
});
