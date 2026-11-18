/**
 * Optional large-file worker on Trigger.dev (https://trigger.dev). Deploy with
 * `npx trigger.dev@latest deploy` after setting TRIGGER_PROJECT_REF, and add TRIGGER_SECRET_KEY
 * to the Vercel project. Without it, processing runs inside the web app.
 */
import { task } from '@trigger.dev/sdk';
import { ingestUpload, reprocessPrint } from '../lib/jobs';

export const ingest = task({
  id: 'ingest-upload',
  machine: 'large-1x', // 8 GB: enough for a 250 MP 16-bit TIFF
  retry: { maxAttempts: 2, outOfMemory: { machine: 'large-2x' } },
  maxDuration: 900,
  run: async ({ uploadId }: { uploadId: string }) => ingestUpload(uploadId),
});

export const reprocess = task({
  id: 'reprocess-print',
  machine: 'large-1x',
  retry: { maxAttempts: 2, outOfMemory: { machine: 'large-2x' } },
  maxDuration: 900,
  run: async ({ printId }: { printId: string }) => reprocessPrint(printId),
});
