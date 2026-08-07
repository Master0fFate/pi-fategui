import { describe, expect, it } from 'vitest';
import { YT_DLP_VERSION, parseSha256Sums, resolveYtDlpTarget } from './prepare-yt-dlp.mjs';

describe('prepare-yt-dlp target selection', () => {
  it('maps supported package targets to pinned standalone executables', () => {
    expect(resolveYtDlpTarget('win32', 'x64')).toMatchObject({ asset: 'yt-dlp.exe', output: 'yt-dlp.exe' });
    expect(resolveYtDlpTarget('windows', 'arm64')).toMatchObject({ asset: 'yt-dlp_arm64.exe', output: 'yt-dlp.exe' });
    expect(resolveYtDlpTarget('linux', 'aarch64')).toMatchObject({ asset: 'yt-dlp_linux_aarch64', output: 'yt-dlp' });
    expect(resolveYtDlpTarget('macos', 'x64')).toMatchObject({ asset: 'yt-dlp_macos', output: 'yt-dlp' });
    expect(YT_DLP_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}$/u);
  });

  it('parses official checksum rows and rejects unsupported targets', () => {
    const sums = parseSha256Sums(`${'a'.repeat(64)}  yt-dlp.exe\n${'b'.repeat(64)} *yt-dlp_linux\ninvalid`);
    expect(sums.get('yt-dlp.exe')).toBe('a'.repeat(64));
    expect(sums.get('yt-dlp_linux')).toBe('b'.repeat(64));
    expect(() => resolveYtDlpTarget('freebsd', 'x64')).toThrow('no pinned standalone executable');
  });
});
