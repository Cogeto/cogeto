import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { applyLanguage, browserLocale } from './i18n';
import { applyTheme, resolveInitialTheme } from './theme';
import './index.css';

// Safety net: the pre-paint /theme-init.js normally sets the theme before
// this bundle runs. If it was ever blocked or failed, apply the resolved theme as
// the bundle executes so the class is always correct (persist=false — the stored
// choice is untouched). No flash in the normal path; correctness even off-path.
applyTheme(resolveInitialTheme(), false);

const queryClient = new QueryClient();

// English is bundled and initialised synchronously when the i18n module is
// imported: it is the fallback for every key, so it must be resident before
// anything renders. The browser's preferred locale is then loaded and applied
// BEFORE the first paint, so no surface shows English and swaps a frame later.
// The user's own `preferred_language` takes over as soon as the session's
// context loads (useInterfaceLanguage); the browser preference never overrides it.
document.documentElement.lang = 'en';
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
// A locale chunk that fails to load must not keep the app from booting: render
// in English either way.
void applyLanguage(browserLocale()).then(render, render);
