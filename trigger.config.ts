import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_set_me',
  dirs: ['./src/trigger'],
  maxDuration: 900,
  build: { external: ['sharp'] },
});
