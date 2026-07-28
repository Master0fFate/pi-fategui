import '@fontsource-variable/noto-sans/wght.css';
import '@fontsource-variable/noto-sans-hebrew/wght.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '@fontsource-variable/noto-sans-mono/wght.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/montserrat/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root was not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
