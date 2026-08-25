import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Focused on the Rules of Hooks — the class of bug that shipped once already
// (a hook placed after a conditional return in EmailView's MessageBody, which
// crashed on PGP messages once the async decrypt flipped state). Kept narrow on
// purpose: the plugin's full v7 "recommended" set flags many intentional
// reset-on-change effects across the app, which is a separate cleanup.
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
])
