import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The runtime page is the one screen that can change a VPS's topology, so these
 * guard the shape of how it is allowed to do that.
 *
 * They read the source rather than render it. That is a blunt instrument, but
 * the properties here are structural — "this page cannot call apply without a
 * token" is a fact about the code, not about a rendered tree, and a test that
 * mounted the page would prove it only for the paths it happened to click.
 */
const rendererRoot = fileURLToPath(new URL('../../renderer/src', import.meta.url));
const page = readFileSync(`${rendererRoot}/features/vps-runtime/VpsRuntimePage.tsx`, 'utf8');
const hooks = readFileSync(`${rendererRoot}/features/vps-runtime/useRuntime.ts`, 'utf8');

describe('VPS runtime renderer policy', () => {
  it('never sends a command string or a credential to the main process', () => {
    // The renderer names a target and an intent. Everything else — the SSH
    // credential, the host key, the shell that eventually runs — stays in the
    // main process, and nothing here may be in a position to influence it.
    expect(hooks).not.toMatch(/privateKey|password|passphrase|hostKey/);
    expect(page).not.toMatch(/privateKey|password|passphrase|hostKey/);
    expect(hooks).not.toMatch(/docker (network|container|volume) /);
  });

  it('applies only with a token the main process minted', () => {
    // The preview token is what binds an apply to a change the user actually
    // saw. A page that could call apply without one would be asking the main
    // process to do whatever it decides is right at that moment.
    expect(page).toMatch(/previewToken: preview\.token/);
    expect(page).not.toMatch(/previewToken: ['"`]/);
  });

  it('cannot apply while a preview reports blockers', () => {
    expect(page).toMatch(/disabled=\{!preview\.applyable/);
  });

  it('requires every destructive operation to be confirmed by name', () => {
    // Typing the resource's exact name is the last gate before something is
    // permanently removed. The main process enforces this too; the page must not
    // offer a button that would only fail there.
    expect(page).toMatch(/typed\[operation\.id\]\?\.trim\(\) === operation\.resource/);
    expect(page).toMatch(/!confirmedAll/);
  });

  it('drops a preview whenever the plan underneath it changes', () => {
    // A preview describes the VPS at one instant. Showing a stale one as though
    // it were still on offer invites the user to authorise a change that no
    // longer matches what would happen.
    expect(page).toMatch(/const dropPreview/);
    for (const mutation of ['setMode', 'adopt']) {
      expect(page, `${mutation} must drop the preview`).toContain('dropPreview()');
    }
  });

  it('does not poll the VPS in the background', () => {
    // Drift and connectivity each open an SSH connection. On a timer they would
    // load someone's production server for a page nobody is looking at.
    expect(hooks).not.toMatch(/refetchInterval/);
  });

  it('offers no way to close a firewall port', () => {
    // Opening is additive and cannot take away access that already works.
    // Closing is a deliberate, separate act and does not belong on this page.
    expect(hooks).not.toMatch(/closeFirewall|runtime:closeFirewall/);
  });
});
