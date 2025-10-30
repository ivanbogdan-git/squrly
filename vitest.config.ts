import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      // Use v8 provider for coverage
      provider: 'v8',
      // Generate a text summary in the console as well as a full HTML report
      reporter: ['text', 'html'],
      // Specify which files to include in the coverage report
      include: ['src/lib/**/*.ts'],
      // Exclude files that don't need to be covered (e.g., type definitions)
      exclude: ['src/lib/types.ts'],
    },
  },
});
