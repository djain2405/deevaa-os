import tseslint from 'typescript-eslint';

export default tseslint.config(
  {ignores: ['.next/**', 'node_modules/**', '.data/**', 'next-env.d.ts']},
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}]
    }
  }
);
