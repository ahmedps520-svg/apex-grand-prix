import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tools/**', 'tests/**', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/pwa/sw-template.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        __APEX_VERSION__: 'readonly',
        __APEX_PRECACHE__: 'readonly',
      },
    },
  },
  {
    // The simulation runs in a worker and in Node tests: keep it free of DOM, three.js and
    // main-thread modules so it behaves identically everywhere.
    files: ['src/sim/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'sim/ must not import three.js.' },
            {
              group: [
                '**/render/**',
                '**/ui/**',
                '**/input/**',
                '**/app/**',
                '**/audio/**',
                '**/pwa/**',
              ],
              message: 'sim/ must stay independent of main-thread modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage'],
    },
  },
);
