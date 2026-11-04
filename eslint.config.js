import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const restrict = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

const SERVER = { regex: '(^|/)server(/|$)', message: 'Only src/server may import server code.' };
const CLIENT = { regex: '(^|/)client(/|$)', message: 'Only src/client may import client code.' };
const NODE = { regex: '^node:', message: 'The domain is pure: no Node APIs.' };
const IO_LIBS = {
  regex: '^(dexie|hono|@hono/.*|better-sqlite3|preact.*|barcode-detector.*|zxing-wasm.*)$',
  message: 'The domain is pure: no IO or UI libraries.',
};
const REPLICA = {
  regex: '(^|/)replica(\\.js|\\.ts)?$',
  message: 'Screens read through views.ts and write through intents.ts, never the replica.',
};

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'docs/', 'test-results/', 'playwright-report/', '.private/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['src/domain/**', 'src/protocol.ts'], rules: restrict(SERVER, CLIENT, NODE, IO_LIBS) },
  { files: ['src/server/**'], rules: restrict(CLIENT) },
  { files: ['src/client/**'], rules: restrict(SERVER) },
  { files: ['src/client/screens/**'], rules: restrict(SERVER, REPLICA) },
  {
    files: ['src/client/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/server/**', 'test/**', 'e2e/**', 'scripts/**', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
