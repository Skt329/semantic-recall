import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'node18',
  external: [
    '@libsql/client',
    '@supabase/supabase-js',
    'openai',
  ],
  banner: {
    js: '/* semantic-memory — persistent semantic memory for LLM apps */',
  },
});
