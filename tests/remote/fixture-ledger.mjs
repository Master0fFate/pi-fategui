import { constants, promises as fs } from 'node:fs';

/** Test-only durable JSONL helper. Empty initial batches still create/fsync a
 * real baseline; append-open never truncates the cumulative restart ledger. */
export async function appendInvocationLedger(file, entries) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invocation ledger must be a regular single-link file');
    if (entries.length) await handle.writeFile(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await handle.sync();
  } finally { await handle.close(); }
}
export async function readInvocationLedger(file) {
  return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
