import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Product tour guards (docs/outreach/PRODUCT-TOUR.md §3.4): the outreach UI reaches data only through the backend
// seam (`db`, `rpc`, `callFn`), links through the mode-aware wrappers, and storage through `kv`; the demo provider
// can never reach a production service.
const OUTREACH_UI = ['app/outreach/**/*.{ts,tsx}', 'components/outreach/**/*.{ts,tsx}', 'lib/outreach/**/*.{ts,tsx}', 'contexts/OutreachWorkspaceContext.tsx'];
const OUTREACH_UI_EXEMPT = [
  'lib/outreach/backend/real.ts',      // the real provider: the one place that talks to Supabase
  'lib/outreach/backend/contract.ts',  // type-only reference to the Supabase client's API
  'lib/outreach/nav.tsx',              // wraps next/link and next/navigation
  'lib/outreach/storage.ts',           // wraps localStorage
  'components/outreach/demo/**',       // the tour shell (reads the raw browser path on purpose)
  'components/outreach/settings/admin/**', 'app/outreach/settings/admin/**',   // platform admin: localhost only, never in the tour
  'app/outreach/invite/**',            // an entry page for a real invitation, not in the tour
  'components/outreach/profile/OwnerPage.tsx',   // the public owner-approval page (outside /outreach)
  'lib/outreach/backend/demo/**',      // has its own, stricter rules below
];

const demoNetworkGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({ name, message: 'Demo code never touches the network (docs/outreach/PRODUCT-TOUR.md §3.4).' }));

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: OUTREACH_UI,
    ignores: OUTREACH_UI_EXEMPT,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '@/utils/supabase/client', message: 'Use `db` from @/lib/outreach/backend (the real/demo seam).' },
          { name: '@/lib/api', message: 'Use rpc / callFn from @/lib/outreach/api.' },
          { name: 'next/link', message: 'Use Link from @/lib/outreach/nav (maps /outreach links into the product tour).' },
          { name: 'next/navigation', message: 'Use @/lib/outreach/nav (useRouter / usePathname are mode-aware).' },
        ],
        patterns: [{ group: ['**/backend/real', '**/backend/demo', '**/backend/demo/**'], message: 'Import `db` from @/lib/outreach/backend, never a provider directly.' }],
      }],
      'no-restricted-globals': ['error',
        { name: 'localStorage', message: 'Use `kv` from @/lib/outreach/storage (demo mode keeps it in sessionStorage).' },
        { name: 'fetch', message: 'Data goes through db / rpc / callFn. Static files on our own origin are the only exception (add an eslint-disable with the reason).' },
      ],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'localStorage', message: 'Use `kv` from @/lib/outreach/storage.' },
        { object: 'window', property: 'fetch', message: 'Data goes through db / rpc / callFn.' },
      ],
      // dynamic imports are not covered by no-restricted-imports
      'no-restricted-syntax': ['error',
        { selector: "ImportExpression[source.value=/(utils\\/supabase|lib\\/api$|backend\\/(real|demo))/]", message: 'Use `db` from @/lib/outreach/backend (the real/demo seam), not a dynamic import of a provider or the Supabase client.' },
      ],
    },
  },
  {
    files: ['lib/outreach/backend/demo/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/*'], message: 'Relative imports only in the demo provider (it is checked as a closed import graph).' },
          { group: ['**/utils/supabase/**', '**/lib/api', '**/outreach/api', '**/backend/real', '**/backend/index', '**/components/**'], message: 'The demo provider must never reach production code.' },
          { group: ['react', 'react-dom', '@tanstack/*', '@supabase/*', 'next', 'next/*'], message: 'The demo provider is plain data code.' },
        ],
      }],
      'no-restricted-globals': ['error', ...demoNetworkGlobals, { name: 'localStorage', message: 'Demo state lives in the store.' }],
      'no-restricted-properties': ['error',
        { object: 'navigator', property: 'sendBeacon', message: 'Demo code never touches the network.' },
        { object: 'window', property: 'fetch', message: 'Demo code never touches the network.' },
        { object: 'Math', property: 'random', message: 'Use the store\'s seeded random (store.random / chance / int / pick).' },
      ],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'supabase/functions/**', 'node_modules/**']),
]);
