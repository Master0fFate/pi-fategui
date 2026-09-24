import type { PiDesktopApi } from '../shared/contracts/ipc';
import { browserApi } from './browserApi';
import { agentsApi } from './agentsApi';
import { learningApi } from './learningApi';
import { mediaApi } from './mediaApi';
import { preferencesApi } from './preferencesApi';
import { runtimeApi } from './runtimeApi';
import { workspaceApi } from './workspaceApi';

export const piDesktopApi: PiDesktopApi = Object.freeze({
  ...browserApi,
  ...agentsApi,
  ...learningApi,
  ...mediaApi,
  ...preferencesApi,
  ...runtimeApi,
  ...workspaceApi,
});
