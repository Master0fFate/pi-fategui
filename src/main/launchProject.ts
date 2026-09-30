import path from 'node:path';

const PROJECT_OPTION = '--project';
const NEW_INSTANCE_OPTION = '--new-instance';
const MAX_PROJECT_PATH_CHARACTERS = 32_768;

function validProjectPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROJECT_PATH_CHARACTERS
    && !value.includes('\0');
}

export function parseLaunchProjectPath(argv: readonly string[], workingDirectory: string): string | null {
  let projectPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === PROJECT_OPTION) {
      const value = argv[index + 1];
      if (!validProjectPath(value) || value.startsWith('--')) throw new Error(`${PROJECT_OPTION} requires a project directory.`);
      projectPath = value;
      index += 1;
    } else if (argument?.startsWith(`${PROJECT_OPTION}=`)) {
      const value = argument.slice(PROJECT_OPTION.length + 1);
      if (!validProjectPath(value)) throw new Error(`${PROJECT_OPTION} requires a project directory.`);
      projectPath = value;
    }
  }
  return projectPath === null ? null : path.resolve(workingDirectory, projectPath);
}

/**
 * True when the launcher asked for a true second Fate UI process instead of
 * routing the folder into the already-running app. Mirrors FATE_NEW_INSTANCE=1.
 */
export function hasNewInstanceFlag(argv: readonly string[]): boolean {
  return argv.includes(NEW_INSTANCE_OPTION);
}

export function projectPathFromAdditionalData(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('projectPath' in value)) return null;
  const projectPath = (value as { projectPath?: unknown }).projectPath;
  return validProjectPath(projectPath) && path.isAbsolute(projectPath) ? path.normalize(projectPath) : null;
}

/** Electron may insert Chromium switches between a split --project and its value. */
export function parseForwardedProjectPath(argv: readonly string[], workingDirectory: string, additionalData: unknown): string | null {
  return projectPathFromAdditionalData(additionalData) ?? parseLaunchProjectPath(argv, workingDirectory);
}

/** Native launch metadata only; never a credential, endpoint or host path. */
export function parseConnectionProfile(argv: readonly string[]): string | null {
  const values = argv.filter((value) => value.startsWith('--connection-profile='));
  if (!values.length) return null;
  const profile = values[0]!.slice('--connection-profile='.length);
  if (values.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(profile)
    || /(?:fo1|fc1|fb1|fs1|ft1|fx1)_/u.test(profile)) throw new Error('Invalid connection profile.');
  return profile;
}
