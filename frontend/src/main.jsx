import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Workbench } from './components/workbench.jsx';
import '@xterm/xterm/css/xterm.css';
import './theme.css';

let terminalApiPromise;
globalThis.loadPapergodTerminal = () => {
  terminalApiPromise ||= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }));
  return terminalApiPromise;
};

const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<Workbench />));

import(/* @vite-ignore */ '/app.js').catch((error) => {
  console.error('Papergod workflow failed to initialize', error);
});
