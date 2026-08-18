import '@fontsource-variable/noto-sans/wght.css';
import '@fontsource-variable/noto-sans-hebrew/wght.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '@fontsource-variable/noto-sans-mono/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';
import { applyTheme, readStoredTheme } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root was not found');

// Paint the last applied theme before the first React frame. Settings and the
// full theme catalog (Pi discovery) resolve asynchronously; without this the
// window would flash the default palette until they arrive.
const storedTheme = readStoredTheme();
if (storedTheme) applyTheme(storedTheme);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
