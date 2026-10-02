import { defineConfig } from 'vitest/config';
import base from './vitest.config';

if (!process.env.FATE_V2_TEST_ROOT) throw new Error('Use the isolated v2 verifier for guarded unit tests.');
// Vitest forks do not retain the launcher's --import hooks. Install the guard
// independently in every project worker, preserving the normal project list.
// Do not merge project arrays: that would leave duplicate unguarded projects.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test!.projects!.map((project) => {
      if (typeof project !== 'object' || !('test' in project)) throw new Error('Unexpected unit project configuration.');
      const setup = project.test?.setupFiles;
      return { ...project, test: { ...project.test,
        setupFiles: ['./tests/network/loopbackGuard.mjs', ...(Array.isArray(setup) ? setup : setup ? [setup] : [])],
      } };
    }),
  },
});
