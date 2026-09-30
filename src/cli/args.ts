export type CliMode = 'init' | 'serve' | 'web' | 'provider' | 'auth-code' | 'access-key' | 'doctor';
export type CliCommand =
  | { readonly mode: 'desktop'; readonly project: string | null; readonly newInstance: boolean }
  | { readonly mode: 'connect'; readonly profile: string }
  | { readonly mode: CliMode; readonly profile: string; readonly verb: string | null; readonly options: Readonly<Record<string, string | true>> };
const modes = new Set(['init', 'serve', 'web', 'connect', 'provider', 'auth-code', 'access-key', 'doctor']);
const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
export class CliUsageError extends Error {
  constructor(scope: 'arguments' | 'desktop' = 'arguments') {
    super(scope === 'desktop' ? 'This mode requires the desktop launcher. Use fate-server help.'
      : 'Invalid CLI mode or argument. Use fate-server help.');
  }
}
const fail = (): never => { throw new CliUsageError(); };
const flags: Record<CliMode | 'desktop' | 'connect', readonly string[]> = {
  desktop: ['project', 'new-instance'], connect: [], init: ['profile', 'workspace', 'trust-workspace', 'port'],
  serve: ['profile'], web: ['profile', 'workspace', 'port', 'trust-workspace'], doctor: ['profile'],
  provider: ['profile', 'provider-id', 'method'], 'auth-code': ['profile', 'out-file'],
  'access-key': ['profile', 'workspace', 'out-file', 'client-id'],
};
/** Pure parsing. No process, profile, credential or filesystem is touched here. */
export function parseCliArgs(argv: readonly string[], entry: 'desktop' | 'server' = 'desktop'): CliCommand {
  if (argv.some((value) => !value || value.length > 32768 || /[\u0000\r\n]/u.test(value)
    || /(?:fo1|fc1|fb1|fs1|ft1|fx1)_[A-Za-z0-9_-]{43}/u.test(value))) fail();
  let mode: CliMode | 'desktop' | 'connect' = 'desktop', index = 0;
  const first = argv[0];
  if (first === '--web') { mode = 'web'; index++; }
  else if (first && modes.has(first)) { mode = first as CliMode | 'connect'; index++; }
  if (entry === 'server' && (mode === 'desktop' || mode === 'connect')) throw new CliUsageError('desktop');
  let verb: string | null = null;
  if (mode === 'provider' || mode === 'access-key') {
    verb = argv[index++] ?? null;
    if (!(mode === 'provider' ? ['login', 'status', 'cancel'] : ['create', 'revoke']).includes(verb ?? '')) fail();
  }
  const options: Record<string, string | true> = {}, positional: string[] = [];
  let literal = false;
  for (; index < argv.length; index++) {
    const token = argv[index]!;
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('--')) {
      const split = token.indexOf('='), name = token.slice(2, split < 0 ? undefined : split);
      if (!flags[mode].includes(name) || Object.hasOwn(options, name)) fail();
      if (name === 'new-instance' || name === 'trust-workspace') {
        if (split >= 0) fail(); options[name] = true;
      } else {
        const value = split < 0 ? argv[++index] : token.slice(split + 1);
        if (!value || value.startsWith('-')) fail(); options[name] = value!;
      }
    } else if (!literal && token.startsWith('-')) fail();
    else positional.push(token);
  }
  if (mode === 'desktop') {
    if (positional.length > 1 || positional.length && options.project) fail();
    return { mode, project: positional[0] ?? (typeof options.project === 'string' ? options.project : null), newInstance: options['new-instance'] === true };
  }
  if (mode === 'connect') { if (positional.length !== 1 || !profilePattern.test(positional[0]!)) fail(); return { mode, profile: positional[0]! }; }
  if (positional.length) fail();
  const profile = typeof options.profile === 'string' ? options.profile : mode === 'web' ? 'default' : '';
  if (!profilePattern.test(profile)) fail();
  if ((mode === 'init' || mode === 'web') && (!options.workspace || options['trust-workspace'] !== true)) fail();
  if (options.port && (!/^[1-9][0-9]{0,4}$/u.test(String(options.port)) || Number(options.port) > 65535)) fail();
  if (mode === 'provider' && (options.method && !['api_key', 'oauth'].includes(String(options.method))
    || verb !== 'login' && (options.method || options['provider-id']))) fail();
  if (mode === 'access-key' && (verb === 'create' ? !options['out-file'] || !options.workspace || options['client-id']
    : !options['client-id'] || options.workspace || options['out-file'])) fail();
  return { mode, profile, verb, options: Object.freeze(options) };
}
