import tseslint from 'typescript-eslint';

// Minimal, fast (non-type-checked) lint across all workspaces.
// eslint-config-next joins at A2, when real React code lands in apps/web.
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/db/src/generated/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
);
