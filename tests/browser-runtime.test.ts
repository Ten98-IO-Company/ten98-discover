import assert from 'node:assert/strict';
import test from 'node:test';
import {isBuiltin} from 'node:module';
import {resolve} from 'node:path';
import {build} from 'vite';

test('performance client bundles without importing server-only built-ins', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'reject-server-builtins-in-browser',
      enforce: 'pre',
      resolveId(source, importer) {
        if (isBuiltin(source)) throw new Error(`Browser module imported ${source} from ${importer}`);
      },
    }],
    build: {
      write: false,
      minify: false,
      lib: {entry: resolve('src/components/WebPerformancePanel.tsx'), formats: ['es']},
      rollupOptions: {external: ['react', 'react/jsx-runtime']},
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  assert.ok(outputs.some(output => 'output' in output && output.output.some(file => file.type === 'chunk' && file.exports.includes('WebPerformancePanel'))));
});
