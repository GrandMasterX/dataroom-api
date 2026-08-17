import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting, limited to rules that catch mistakes rather than restate style.
 * Formatting is Prettier's job; a linter that argues about quotes wastes review attention on
 * the wrong things.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'src/generated/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Nest's decorators and Prisma's generated types produce plenty of legitimate
      // any-shaped values at the boundaries; the interesting rule is the one below.
      '@typescript-eslint/no-explicit-any': 'off',
      // A forgotten await on a database call is the failure this whole set is here to catch.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // Test fixtures and scripts read fine with looser typing at the edges.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
