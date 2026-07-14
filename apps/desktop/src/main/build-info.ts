export interface BuildInfo {
  readonly buildNumber: string;
  readonly gitCommit: string;
  readonly builtAt: string;
}

declare const __CLOUDFORGE_BUILD_INFO__: BuildInfo;

/** Immutable metadata embedded by electron-vite when the main bundle is built. */
export const BUILD_INFO: BuildInfo = __CLOUDFORGE_BUILD_INFO__;
