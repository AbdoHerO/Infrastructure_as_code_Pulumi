import { toast } from '@cloudforge/ui';
import { invoke } from './ipc.js';

/**
 * Copy through the main process and say what really happened. The window is denied
 * browser permissions, the clipboard's included, so `navigator.clipboard` fails here.
 */
export async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await invoke('app:copyText', { text });
    toast.success(`${label} copied`);
  } catch (error) {
    toast.error(`Could not copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}
