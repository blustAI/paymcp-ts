import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts', 
      'tests/**/*.test.ts'
    ],
    exclude: [
      'node_modules', 
      'dist', 
      'examples',
      'coverage'
    ],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'examples/**',
        'tests/**'
      ],
    },
    testTimeout: 10000, // 10 seconds for integration tests
  },
});