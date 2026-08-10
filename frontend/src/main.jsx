import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Workbench } from './components/workbench.jsx';
import './theme.css';

const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<Workbench />));

import(/* @vite-ignore */ '/app.js').catch((error) => {
  console.error('Papergod workflow failed to initialize', error);
});
