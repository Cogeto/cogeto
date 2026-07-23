import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { applyTheme, resolveInitialTheme } from './theme';
import './index.css';

// Safety net (P6.8): the pre-paint /theme-init.js normally sets the theme before
// this bundle runs. If it was ever blocked or failed, apply the resolved theme as
// the bundle executes so the class is always correct (persist=false — the stored
// choice is untouched). No flash in the normal path; correctness even off-path.
applyTheme(resolveInitialTheme(), false);

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
