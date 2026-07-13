import type { CloudForgeBridge } from './index.js';

declare global {
  interface Window {
    /** The secure IPC bridge exposed by the preload script. */
    readonly cloudforge: CloudForgeBridge;
  }
}

export {};
