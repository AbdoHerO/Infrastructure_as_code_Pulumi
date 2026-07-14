import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { NginxSite } from '@cloudforge/core';
import { ANSIBLE_PROFILES, getPlaybook } from './ansible-playbooks.js';
import { renderManagedNginxSite, validateNginxSite } from './ssh-ansible-manager.js';

describe('generic Ansible catalog', () => {
  it('has one safe local playbook for every unique profile', () => {
    expect(new Set(ANSIBLE_PROFILES.map((profile) => profile.id)).size).toBe(5);
    for (const profile of ANSIBLE_PROFILES) {
      const playbook = getPlaybook(profile.id);
      expect(playbook).toContain('hosts: localhost');
      expect(playbook).toContain('connection: local');
      expect(playbook).toContain('become: true');
      expect(playbook).not.toMatch(/HanoutPlus|51\.170\.|abder|ABDOwahna/i);
      const parsed = parseDocument(playbook);
      expect(parsed.errors, `${profile.name} must be valid YAML`).toHaveLength(0);
    }
  });

  it('keeps all deployment-specific values variable-driven', () => {
    expect(getPlaybook('dockhand')).toContain('"{{ port }}:3000"');
    expect(getPlaybook('dockhand')).toContain('image: "{{ image }}"');
    expect(getPlaybook('portainer')).toContain('"{{ port }}:9443"');
    expect(getPlaybook('jenkins')).toContain('JENKINS_PORT={{ port }}');
    expect(getPlaybook('nginx')).not.toContain('server_name');
  });
});

describe('managed Nginx sites', () => {
  const site: NginxSite = {
    domain: 'app.example.com',
    upstreamHost: '127.0.0.1',
    upstreamPort: 3000,
    websocket: true,
  };

  it('validates and renders a reversible CloudForge-owned config', () => {
    expect(validateNginxSite(site).ok).toBe(true);
    const config = renderManagedNginxSite(site);
    expect(config).toContain('# cloudforge-domain: app.example.com');
    expect(config).toContain('proxy_pass http://127.0.0.1:3000;');
    expect(config).toContain('proxy_set_header Upgrade $http_upgrade;');
  });

  it.each([
    { ...site, domain: 'bad domain' },
    { ...site, domain: 'example.com; include /tmp/x' },
    { ...site, upstreamHost: '127.0.0.1;reboot' },
    { ...site, upstreamPort: 0 },
    { ...site, upstreamPort: 65536 },
  ])('rejects unsafe site input', (candidate) => {
    expect(validateNginxSite(candidate).ok).toBe(false);
  });
});
