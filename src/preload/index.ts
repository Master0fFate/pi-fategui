import { contextBridge } from 'electron';
import { piDesktopApi } from './api';

contextBridge.exposeInMainWorld('piDesktop', piDesktopApi);
