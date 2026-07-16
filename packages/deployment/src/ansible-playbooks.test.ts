import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { ManagedNginxSite, NginxSite } from '@cloudforge/core';
import { NGINX_SITE_MARKER, renderManagedNginxSite } from '@cloudforge/core';
import { ANSIBLE_PROFILES, getPlaybook } from './ansible-playbooks.js';
import { jenkinsServiceActionScript, parseProfileStates } from './ssh-ansible-manager.js';
import { validateNginxSite } from './ssh-ansible-manager.js';
import {
  legacyAnsibleSiteFilePath,
  managedSiteFilePath,
  siteFilePaths,
  toManagedNginxSite,
  toNginxSite,
} from './nginx-site-file.js';

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
    expect(getPlaybook('dockhand')).toContain('"{{ service_port }}:3000"');
    expect(getPlaybook('dockhand')).toContain('image: "{{ image }}"');
    expect(getPlaybook('portainer')).toContain('"{{ service_port }}:9443"');
    expect(getPlaybook('jenkins')).toContain('JENKINS_PORT={{ service_port }}');
    expect(getPlaybook('jenkins')).toContain('ansible.builtin.deb822_repository');
    expect(getPlaybook('jenkins')).not.toContain('ansible.builtin.apt_repository');
    expect(getPlaybook('jenkins')).not.toContain('ansible_os_family');
    expect(getPlaybook('dockhand')).not.toContain('{{ port }}');
    expect(getPlaybook('nginx')).not.toContain('server_name');
  });

  it('verifies and repairs Docker bridge networking after firewalld startup races', () => {
    const playbook = getPlaybook('docker');
    expect(playbook).toContain('After=network-online.target firewalld.service');
    expect(playbook).toContain('docker network create --driver bridge cloudforge-network-probe');
    expect(playbook).toContain('Repair Docker firewall chains after a firewalld startup race');
    expect(playbook).toContain("'DOCKER-FORWARD' in docker_network_probe.stderr");
  });

  it('uses current Ansible facts and repository modules', () => {
    const docker = getPlaybook('docker');
    expect(docker).toContain('ansible.builtin.deb822_repository');
    expect(docker).not.toContain('ansible.builtin.apt_repository');
    expect(docker).not.toContain('ansible_os_family');
  });

  it('manages native service ports through the active VPS firewall', () => {
    for (const profile of ['jenkins', 'nginx'] as const) {
      const playbook = getPlaybook(profile);
      expect(playbook).toContain('through the active VPS firewall');
      expect(playbook).toContain("--comment 'CloudForge managed service'");
      expect(playbook).toContain('netfilter-persistent save');
      expect(playbook).toContain('manage_host_firewall | default(true) | bool');
    }
  });
});

describe('live Ansible profile state', () => {
  it('parses installed, running, stopped, and host-firewall state', () => {
    const states = parseProfileStates(`noise
CF_PROFILE|docker|true|true|27.5.1|-|unknown|Docker Engine service|docker_users=ubuntu,jenkins
CF_PROFILE|dockhand|true|true|fnsys/dockhand:latest|3000|unknown|Dockhand container
CF_PROFILE|portainer|false|false||-|unknown|Portainer container is absent
CF_PROFILE|jenkins|true|false|2.516.1|8080|closed|Jenkins native service
CF_PROFILE|nginx|true|true|1.24.0|80|open|Nginx native service
`);

    expect(states).toHaveLength(5);
    expect(states.find((state) => state.profileId === 'dockhand')).toMatchObject({
      status: 'running',
      port: 3000,
    });
    expect(states.find((state) => state.profileId === 'docker')).toMatchObject({
      configuration: { docker_users: 'ubuntu,jenkins' },
    });
    expect(states.find((state) => state.profileId === 'portainer')).toMatchObject({
      status: 'not-installed',
      installed: false,
    });
    expect(states.find((state) => state.profileId === 'jenkins')).toMatchObject({
      status: 'stopped',
      hostFirewallOpen: false,
    });
    expect(states.find((state) => state.profileId === 'nginx')).toMatchObject({
      status: 'running',
      hostFirewallOpen: true,
    });
  });
});

describe('Jenkins service actions', () => {
  it('verifies service, listener, Docker group and Docker daemon access without mutation', () => {
    const script = jenkinsServiceActionScript('verify');
    expect(script).toContain('systemctl is-active --quiet jenkins');
    expect(script).toContain('ss -ltnH');
    expect(script).toContain('id -nG jenkins');
    expect(script).toContain('runuser -u jenkins -- docker info');
    expect(script).not.toContain('systemctl restart jenkins');
  });

  it('restarts Jenkins and then runs the same health checks', () => {
    const script = jenkinsServiceActionScript('restart');
    expect(script).toContain('systemctl restart jenkins');
    expect(script).toContain('systemctl is-active --quiet jenkins');
    expect(script.indexOf('systemctl restart jenkins')).toBeLessThan(
      script.indexOf('systemctl is-active --quiet jenkins'),
    );
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
    const config = renderManagedNginxSite(toManagedNginxSite(site));
    expect(config).toContain('proxy_pass http://127.0.0.1:3000;');
    expect(config).toContain('proxy_set_header Upgrade $http_upgrade;');
  });

  it('writes the same format the Nginx Manager and SSL read', () => {
    // Both writers previously used different metadata, so a site created here
    // was invisible to the Nginx Manager and SSL refused to issue for it.
    const config = renderManagedNginxSite(toManagedNginxSite(site));

    expect(config).toContain(NGINX_SITE_MARKER);
    expect(config).not.toContain('# cloudforge-domain:');
  });

  it('writes the same file the Nginx Manager writes for a domain', () => {
    expect(managedSiteFilePath('app.example.com')).toBe(
      '/etc/nginx/conf.d/cloudforge-app.example.com.conf',
    );
  });

  it('knows the pre-unification file name so it can be cleaned up', () => {
    // Left behind, the old file keeps its server_name and conflicts with the new one.
    expect(legacyAnsibleSiteFilePath('app.example.com')).toBe(
      '/etc/nginx/conf.d/cloudforge-app-example-com.conf',
    );
    expect(siteFilePaths('app.example.com')).toEqual([
      '/etc/nginx/conf.d/cloudforge-app.example.com.conf',
      '/etc/nginx/conf.d/cloudforge-app-example-com.conf',
    ]);
  });

  it('lists one path for a domain whose names coincide', () => {
    expect(siteFilePaths('localhost')).toEqual(['/etc/nginx/conf.d/cloudforge-localhost.conf']);
  });

  it('preserves settings owned by the Nginx Manager when editing a route', () => {
    // This tab edits an upstream. It must not clear the TLS, routes or headers
    // a user configured through the richer editor.
    const existing: ManagedNginxSite = {
      ...toManagedNginxSite(site),
      ssl: true,
      httpRedirect: true,
      certificatePath: '/opt/cloudforge/certs/live/app.example.com',
      headers: [{ name: 'X-Custom', value: 'yes' }],
      locations: [{ path: '/app', upstreamHost: '127.0.0.1', upstreamPort: 8081 }],
      clientMaxBodySize: '50m',
    };
    const merged = toManagedNginxSite({ ...site, upstreamPort: 4000 }, existing);

    expect(merged.upstreamPort).toBe(4000);
    expect(merged.ssl).toBe(true);
    expect(merged.certificatePath).toBe('/opt/cloudforge/certs/live/app.example.com');
    expect(merged.headers).toEqual([{ name: 'X-Custom', value: 'yes' }]);
    expect(merged.locations).toHaveLength(1);
    expect(merged.clientMaxBodySize).toBe('50m');
  });

  it('classifies a container upstream when widening a route', () => {
    expect(toManagedNginxSite({ ...site, upstreamHost: 'api' }).upstreamKind).toBe('docker');
    expect(toManagedNginxSite(site).upstreamKind).toBe('host');
  });

  it('narrows back to the four fields this tab presents', () => {
    expect(toNginxSite(toManagedNginxSite(site))).toEqual(site);
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
