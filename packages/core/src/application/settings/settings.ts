/**
 * The application's persisted settings. Client-only preferences (like theme
 * mode) live in the renderer; this is the durable, main-process-owned state.
 */
export interface AppSettings {
  readonly appearance: {
    readonly reducedMotion: boolean;
  };
  readonly deployment: {
    readonly confirmDestructive: boolean;
    readonly defaultRegion: string;
  };
  readonly logs: {
    readonly retentionDays: number;
  };
}

/** Immutable default settings applied when no stored value exists. */
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { reducedMotion: false },
  deployment: { confirmDestructive: true, defaultRegion: '' },
  logs: { retentionDays: 30 },
};

/** A deep-partial patch for updating settings. */
export type SettingsPatch = {
  readonly [K in keyof AppSettings]?: Partial<AppSettings[K]>;
};
