import { registerAppHandlers } from './handlers/app.handlers.js';

/**
 * Register every IPC handler exactly once during app startup. Feature modules
 * add their registration function here as the application grows.
 */
export function registerIpcHandlers(): void {
  registerAppHandlers();
}
