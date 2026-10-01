import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { CliUsageError, parseCliArgs } from './args';
import { ProviderLoginOperatorError } from './providerLogin';
class NodePrerequisiteError extends Error {
  constructor() { super('Install Node 22.19 or later for the separate fate-server companion.'); }
}
export const cliHelp = 'fate-server init --profile NAME --workspace PATH --trust-workspace [--port PORT]\nfate-server serve --profile NAME\nfate-server web --workspace PATH --trust-workspace [--profile NAME]\nfate-server provider login|status|cancel --profile NAME\nfate-server auth-code --profile NAME [--out-file PRIVATE_FILE]\nfate-server access-key create --profile NAME --workspace PATH --out-file PRIVATE_FILE\nfate-server access-key revoke --profile NAME --client-id ID\nfate-server doctor --profile NAME';
/** Plain Node entry. Never invokes Electron, downloads a runtime or resolves a desktop launcher. */
export async function runCli(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && ['help', '--help'].includes(argv[0]!)) { process.stdout.write(`${cliHelp}\n`); return; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!major || major < 22 || major === 22 && (minor ?? 0) < 19) throw new NodePrerequisiteError();
  // Fixed launcher discovery only: no profile/credential IO, runtime startup,
  // or user argument evaluation. Installed npm/pnpm shims know this entry.
  if (argv.length === 1 && argv[0] === '--launcher-entry') {
    // Windows PowerShell 5 decodes native stdout using the console code page.
    // An ASCII JSON protocol preserves Unicode installed paths without changing
    // the caller's console configuration or evaluating any caller expression.
    const metadata = JSON.stringify({ version: 1, entry: fileURLToPath(import.meta.url) });
    process.stdout.write(`${metadata.replace(/[^\x00-\x7f]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`);
    return;
  }
  const command = parseCliArgs(argv, 'server');
  if (command.mode === 'desktop' || command.mode === 'connect') throw new Error('Use the desktop launcher for this mode.');
  if (command.mode === 'doctor') {
    const { doctor } = await import('./doctor'); process.stdout.write(`${JSON.stringify(await doctor(command.profile))}\n`); return;
  }
  const { runHostCommand } = await import('./hostCommands');
  await runHostCommand(command);
}
function isMainEntry(): boolean {
  try { return Boolean(process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainEntry()) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(error instanceof ProviderLoginOperatorError ? `${error.operatorMessage}\n`
      : error instanceof CliUsageError || error instanceof NodePrerequisiteError ? `${error.message}\n`
      : 'Fate server command failed. Check the mode, host profile, running server and private file permissions.\n');
    process.exitCode = 1;
  }
}
