/** The extension points a plugin can contribute to. */
export const PLUGIN_KINDS = ['provider', 'template', 'widget', 'theme', 'ansible-role'] as const;

export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** A plugin's manifest: its identity and which extension point it contributes to. */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly description: string;
  readonly author: string;
  /** Declarative capability interpreted by trusted application code. */
  readonly contribution?: 'theme:nord';
}
