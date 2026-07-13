import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_TEMPLATES,
  findTemplate,
  listTemplateSummaries,
} from './deployment-template.js';

describe('deployment templates', () => {
  it('exposes summaries without the build function', () => {
    const summaries = listTemplateSummaries();
    expect(summaries.length).toBe(DEPLOYMENT_TEMPLATES.length);
    expect(summaries[0]).not.toHaveProperty('build');
  });

  it('docker-base templates install and enable Docker', () => {
    const template = findTemplate('docker-host');
    expect(template).toBeDefined();
    const steps = template!.build({});
    const commands = steps.map((s) => s.command).join('\n');
    expect(commands).toContain('get.docker.com');
    expect(commands).toContain('docker-ce.repo');
    expect(commands).toContain('command -v dnf');
    expect(commands).toContain('systemctl enable --now docker');
  });

  it('app templates interpolate the provided image', () => {
    const steps = findTemplate('node')!.build({ appImage: 'ghcr.io/acme/api:1.2.3' });
    expect(steps.some((s) => s.command.includes('ghcr.io/acme/api:1.2.3'))).toBe(true);
  });

  it('returns undefined for an unknown template', () => {
    expect(findTemplate('does-not-exist')).toBeUndefined();
  });
});
