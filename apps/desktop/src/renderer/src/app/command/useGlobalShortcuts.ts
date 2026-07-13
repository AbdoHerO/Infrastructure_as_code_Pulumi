import { useEffect } from 'react';
import { useCommandPalette } from './command-store.js';

/**
 * Register application-wide keyboard shortcuts. Currently ⌘K / Ctrl+K toggles
 * the command palette. Additional shortcuts are added here as the app grows.
 */
export function useGlobalShortcuts(): void {
  const toggle = useCommandPalette((s) => s.toggle);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);
}
