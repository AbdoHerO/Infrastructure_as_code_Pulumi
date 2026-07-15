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
  readonly cloudflare: {
    readonly defaultCredentialId: string;
    readonly defaultZoneId: string;
    readonly defaultTtl: number;
    readonly defaultProxy: boolean;
    readonly waitForPropagation: boolean;
    readonly propagationTimeoutSeconds: number;
    readonly autoRefreshMinutes: number;
    readonly autoSync: boolean;
    readonly automaticDnsCreation: boolean;
    readonly automaticSsl: boolean;
    readonly automaticHttpsRedirect: boolean;
    readonly cacheTtl: number;
    readonly preferredSslMode: 'off' | 'flexible' | 'full' | 'strict';
    readonly developmentMode: boolean;
    readonly confirmDelete: boolean;
    readonly activityLogging: boolean;
  };
}

/** Immutable default settings applied when no stored value exists. */
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { reducedMotion: false },
  deployment: { confirmDestructive: true, defaultRegion: '' },
  logs: { retentionDays: 30 },
  updates: { checkOnStartup: true, autoDownload: false },
  ssl: { autoRenew: true, renewBeforeDays: 30, checkIntervalHours: 24, managed: [] },
  cloudflare: {
    defaultCredentialId: '',
    defaultZoneId: '',
    defaultTtl: 1,
    defaultProxy: true,
    waitForPropagation: true,
    propagationTimeoutSeconds: 300,
    autoRefreshMinutes: 15,
    autoSync: true,
    automaticDnsCreation: false,
    automaticSsl: false,
    automaticHttpsRedirect: true,
    cacheTtl: 14400,
    preferredSslMode: 'strict',
    developmentMode: false,
    confirmDelete: true,
    activityLogging: true,
  },
};

/** A deep-partial patch for updating settings. */
export type SettingsPatch = {
  readonly [K in keyof AppSettings]?: Partial<AppSettings[K]>;
};
