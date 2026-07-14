import { shell } from 'electron';
import { isSafeExternalUrl } from './external-url.js';

export const PRODUCT_EXTERNAL_LINKS = {
  github: 'https://github.com/AbdoHerO/Infrastructure_as_code_Pulumi',
  releases: 'https://github.com/AbdoHerO/Infrastructure_as_code_Pulumi/releases',
} as const;

export type ProductExternalLink = keyof typeof PRODUCT_EXTERNAL_LINKS;

export async function openProductExternalLink(link: ProductExternalLink): Promise<void> {
  const url = PRODUCT_EXTERNAL_LINKS[link];
  await shell.openExternal(url);
}

export async function openSafeExternalUrl(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) return;
  await shell.openExternal(url);
}
