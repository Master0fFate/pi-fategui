import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function resolveDevelopmentProfile(projectRoot, env = process.env) {
  const normalizedRoot = path.resolve(projectRoot);
  const projectKey = createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 12);
  const configuredRoot = env.PI_DESKTOP_DEV_PROFILE?.trim();
  const profileRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(tmpdir(), 'fate-ui-dev', projectKey);
  const configuredDataRoot = env.FATE_GUI_DATA_DIR?.trim();

  return {
    profileRoot,
    electronUserData: path.join(profileRoot, 'electron'),
    fateGuiData: configuredDataRoot ? path.resolve(configuredDataRoot) : path.join(profileRoot, 'fateGUI'),
  };
}
