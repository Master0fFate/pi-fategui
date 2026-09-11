import '@fontsource-variable/noto-sans/wght.css';
import '@fontsource-variable/noto-sans-hebrew/wght.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '@fontsource-variable/noto-sans-mono/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { SkinProvider } from './skins/SkinProvider';
import { NativeTitleTooltips } from './skins/NativeTitleTooltips';
import { BackgroundProvider } from './background/BackgroundProvider';
import './background/background.css';
import './styles/global.css';
import './styles/skins/dreamcore.css';
import './styles/skins/dreamcore-terminal.css';
import './styles/skins/packs.css';
import './styles/skins/angelcore-surfaces.css';
import './styles/skins/angelcore-browser.css';
import { applySkinDefinition, readStoredSkinDefinition } from './skin';
import { applyTheme, readStoredTheme } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root was not found');

// Paint the last applied theme before the first React frame. Settings and the
// full theme catalog (Pi discovery) resolve asynchronously; without this the
// window would flash the default palette until they arrive.
const storedTheme = readStoredTheme();
if (storedTheme) applyTheme(storedTheme);
const storedSkin = readStoredSkinDefinition();
if (storedSkin) applySkinDefinition(storedSkin, { persist: false });

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <SkinProvider><BackgroundProvider><App /><NativeTitleTooltips /></BackgroundProvider></SkinProvider>
  </React.StrictMode>,
);
