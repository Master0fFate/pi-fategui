import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CliUsageError, parseCliArgs } from './args';
class NodePrerequisiteError extends Error {
  constructor() { super('Install Node 22.19 or later for the separate fate-server companion.'); }
}
export const cliHelp = 'fate-server init --profile NAME --workspace PATH --trust-workspace [--port PORT]\nfate-server serve --profile NAME\nfate-server web --workspace PATH --trust-workspace [--profile NAME]\nfate-server provider login|status|cancel --profile NAME\nfate-server auth-code --profile NAME [--out-file PRIVATE_FILE]\nfate-server access-key create --profile NAME --workspace PATH --out-file PRIVATE_FILE\nfate-server access-key revoke --profile NAME --client-id ID\nfate-server doctor --profile NAME';
/** Plain Node entry. Never invokes Electron, downloads a runtime or resolves a desktop launcher. */
export async function runCli(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && ['help', '--help'].includes(argv[0]!)) { process.stdout.write(`${cliHelp}\n`); return; }
  const command = parseCliArgs(argv, 'server');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!major || major < 22 || major === 22 && (minor ?? 0) < 19) throw new NodePrerequisiteError();
  if (command.mode === 'desktop' || command.mode === 'connect') throw new Error('Use the desktop launcher for this mode.');
  if (command.mode === 'doctor') {
    const { doctor } = await import('./doctor'); process.stdout.write(`${JSON.stringify(await doctor(command.profile))}\n`); return;
  }
  const { runHostCommand } = await import('./hostCommands');
  await runHostCommand(command);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(error instanceof CliUsageError || error instanceof NodePrerequisiteError ? `${error.message}\n`
      : 'Fate server command failed. Check the mode, host profile, running server and private file permissions.\n');
    process.exitCode = 1;
  }
}
