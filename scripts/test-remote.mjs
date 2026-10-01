import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { activationPhrase, Evidence, validateFixture, sshExecutable } from '../tests/remote/fixture-lib.mjs';
import { assertNoIndirectFixturePath, assertPrivateFixtureStorage } from '../tests/remote/fixture-private-storage.mjs';

/** No local daemon provisioning, fake SSH, implicit deployment, or gate changes.
 * The operator must explicitly supply a preinstalled disposable Linux fixture.
 */
export async function main(args = process.argv.slice(2)) {
  let evidence;
  try {
    const readArg = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
    const fixtureFile = readArg('--fixture'); const output = readArg('--evidence');
    if (!fixtureFile || !output) throw new Error('REMOTE_FIXTURE_UNAVAILABLE: supply --fixture <private JSON> --evidence <new directory>; no supported external fixture configured.');
    const f = validateFixture(JSON.parse(await fs.readFile(fixtureFile, 'utf8')));
    if (!args.includes('--activate') || process.env.FATE_T50_ACTIVATION_APPROVAL !== activationPhrase) {
      throw new Error('REMOTE_ACTIVATION_REFUSED: source preparation only; explicit supported fixture and separate operator activation approval required. T48/T49/T50 gates are never changed by this runner.');
    }
    // Read-only prerequisite gate. The fixture manifest/approval phrase cannot
    // replace real plan acceptance or make a missing review into a passing gate.
    const planRoot = fileURLToPath(new URL('../plans/', import.meta.url));
    const progressBytes = await fs.readFile(path.join(planRoot, 'progress.json')).catch(() => { throw new Error('REMOTE_ACTIVATION_REFUSED: prerequisite ledger unavailable'); });
    const progress = JSON.parse(progressBytes.toString('utf8'));
    const prerequisiteEvidence = [];
    for (const id of ['T48', 'T49']) {
      const task = progress.tasks?.[id];
      if (task?.status !== 'accepted' || typeof task.report !== 'string' || !task.report) throw new Error(`REMOTE_ACTIVATION_REFUSED: ${id} is not independently accepted`);
      const report = path.resolve(planRoot, task.report);
      if (!report.startsWith(planRoot)) throw new Error('REMOTE_ACTIVATION_REFUSED: prerequisite report escapes plan directory');
      const bytes = await fs.readFile(report).catch(() => { throw new Error(`REMOTE_ACTIVATION_REFUSED: ${id} review report unavailable`); });
      if (!bytes.length || typeof task.reviewer !== 'string' || !task.reviewer) throw new Error(`REMOTE_ACTIVATION_REFUSED: ${id} independent review unavailable`);
      prerequisiteEvidence.push({ id, report: task.report, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const privateStorageProofs = [];
    for (const credential of [fixtureFile, f.identityFile, f.knownHostsFile, f.reviewedBindingFile]) privateStorageProofs.push(await assertPrivateFixtureStorage(credential));
    const reviewedBytes = await fs.readFile(f.reviewedBindingFile);
    f.reviewedBinding = { manifest: JSON.parse(reviewedBytes.toString('utf8')), digest: createHash('sha256').update(reviewedBytes).digest('hex') };
    await assertNoIndirectFixturePath(output, { missingLeaf: true });
    privateStorageProofs.push(await assertPrivateFixtureStorage(path.dirname(path.resolve(output)), { directory: true }));
    await fs.mkdir(path.resolve(output), { mode: 0o700 }); // exclusive fresh evidence, no overwrite
    // On Windows this is actual read-only NTFS SID/DACL verification. Mode
    // 0700 alone is not privacy evidence. Refuse before any credential/log write.
    privateStorageProofs.push(await assertPrivateFixtureStorage(path.resolve(output), { directory: true }));
    evidence = new Evidence(path.resolve(output));
    await evidence.record('private-storage-preflight', { proofs: privateStorageProofs });
    await evidence.record('reviewed-binding-input', { path: f.reviewedBindingFile, sha256: f.reviewedBinding.digest, manifest: f.reviewedBinding.manifest });
    await evidence.record('activation-input', { fixtureFile: path.resolve(fixtureFile), node: process.version, platform: process.platform,
      sshHost: f.host, sshPort: f.sshPort, localPort: f.localPort, hostPort: f.hostPort, requiredWorkflowExecuted: false,
      prerequisiteEvidence, progressDigest: createHash('sha256').update(progressBytes).digest('hex') });
    const version = await evidence.run(sshExecutable(), ['-V']); if (version.code !== 0) throw new Error('REMOTE_FIXTURE_UNAVAILABLE: real OpenSSH client missing');
    const { executeRemoteWorkflow } = await import('../tests/remote/workflow.mjs');
    await executeRemoteWorkflow(f, evidence);
    const finalStorageProof = await assertPrivateFixtureStorage(evidence.root, { directory: true, tree: true });
    await evidence.record('private-storage-final', { proof: finalStorageProof });
    await evidence.record('workflow-complete', { acceptance: 'not asserted; independent gate review required', cleanup: 'verified', privateStorage: 'verified' });
    process.stdout.write('Remote fixture assertions executed. NOT gate acceptance; independent review required.\n');
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = evidence ? evidence.redact(detail) : detail;
    if (evidence) {
      try { await evidence.record('failed-unfinished', { message, acceptance: false }); }
      catch (logError) { process.stderr.write(`Failure evidence unavailable: ${String(logError)}\n`); }
    }
    process.stderr.write(`${message}\n`); return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
