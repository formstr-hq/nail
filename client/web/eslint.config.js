import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      // recommended-latest: v7's flat recommended (incl. the new
      // set-state-in-effect / refs compiler rules). The ported client code
      // predates them and is tracked in docs/FRONTEND_AUDIT.md — the
      // offenders get refactored in Phase 5, not silenced piecemeal here.
      // (configs.recommended-latest is the eslintrc-style object; the flat
      // shape is configs.flat.recommended, which this plugin version
      // predates the new compiler rules in.)
      {
        plugins: { 'react-hooks': reactHooks },
        rules: {
          'react-hooks/rules-of-hooks': 'error',
          'react-hooks/exhaustive-deps': 'warn',
          'react-hooks/set-state-in-effect': 'warn',
          'react-hooks/refs': 'warn',
          'react-hooks/purity': 'warn',
          'react-hooks/set-state-in-render': 'warn',
          'react-hooks/static-components': 'warn',
          'react-hooks/use-memo': 'warn',
          'react-hooks/void-use-memo': 'warn',
          'react-hooks/immutability': 'warn',
          'react-hooks/globals': 'warn',
          'react-hooks/error-boundaries': 'warn',
          'react-hooks/preserve-manual-memoization': 'warn',
          'react-hooks/incompatible-library': 'warn',
          'react-hooks/unsupported-syntax': 'warn',
        },
      },
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Phase 2 is a port, not a refactor: the known offenders (god
      // components, sync setState in effects) are flagged and scheduled.
      // Downgrade the new-to-this-codebase react-hooks v7 compiler rules so
      // `pnpm lint` gates real regressions without blocking the merge.
    },
  },
  // Store bundles must contain no Lightning and no card code. The bundler can
  // only drop what is never statically imported, so shared code may reach a
  // payment rail ONLY through a dynamic import() inside a build-time branch
  // (lib/payments/methods.ts, PriceTag.tsx, ...).
  // This bans the static route; files that belong to a rail are exempt below.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/payments/lightning/*',
                '@/lib/payments/stripe/*',
                '@/lib/payments/store/*',
                '**/lib/payments/lightning/*',
                '**/lib/payments/stripe/*',
                '**/lib/payments/store/*',
              ],
              message:
                'Payment rails are loaded with a dynamic import() behind VITE_STORE_BUILD (see lib/payments/methods.ts); a static import ships the rail in store bundles.',
            },
            {
              group: [
                '@/components/payments/LightningPay',
                '@/components/payments/StripePay',
                '@/components/payments/StorePay',
                '@/components/payments/StorePrice',
                '@/components/payments/StoreSeatPacks',
                '@/components/payments/OpenPrice',
                '@/components/payments/InvoiceQR',
              ],
              message:
                'Payment method components are loaded with a dynamic import() behind VITE_STORE_BUILD (see lib/payments/methods.ts).',
            },
            {
              group: ['@stripe/*', 'qrcode.react'],
              message: 'Only the card / Lightning method components may import this (store bundles must not contain it).',
            },
          ],
        },
      ],
    },
  },
  {
    // The rails themselves, and tests (which are never bundled).
    files: [
      'src/**/*.test.{ts,tsx}',
      'src/lib/payments/lightning/**',
      'src/lib/payments/stripe/**',
      'src/lib/payments/store/**',
      'src/components/payments/{LightningPay,StripePay,StorePay,StorePrice,StoreSeatPacks,OpenPrice,InvoiceQR,PayInPicker,PayInPrice}.tsx',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
])
