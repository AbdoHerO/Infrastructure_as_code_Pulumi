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
  readonly updates: {
    readonly checkOnStartup: boolean;
    readonly autoDownload: boolean;
  };
  readonly ssl: {
    readonly autoRenew: boolean;
    readonly renewBeforeDays: number;
    readonly checkIntervalHours: number;
    readonly managed: readonly {
      readonly targetId: string;
      readonly domain: string;
      readonly email: string;
      readonly certificateVolume: string;
      readonly webrootVolume: string;
    }[];
  };
}

/** Immutable default settings applied when no stored value exists. */
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { reducedMotion: false },
  deployment: { confirmDestructive: true, defaultRegion: '' },
  logs: { retentionDays: 30 },
  updates: { checkOnStartup: true, autoDownload: false },
  ssl: { autoRenew: true, renewBeforeDays: 30, checkIntervalHours: 24, managed: [] },
};

/** A deep-partial patch for updating settings. */
export type SettingsPatch = {
  readonly [K in keyof AppSettings]?: Partial<AppSettings[K]>;
};
