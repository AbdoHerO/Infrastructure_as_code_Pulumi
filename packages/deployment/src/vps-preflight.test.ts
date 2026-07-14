import { describe, expect, it } from 'vitest';
import {
  buildPreflightReport,
  parsePreflightOutput,
  preflightCommand,
  profilePort,
} from './vps-preflight.js';

const ready = {
  hostname: 'arm-vps',
  os_id: 'ubuntu',
  os_name: 'Ubuntu 24.04 LTS',
  os_version: '24.04',
  arch: 'aarch64',
  kernel: 'Linux 6.8',
  package_manager: 'apt',
  init: 'systemd',
  privilege: 'sudo',
  python_version: '3.12.3',
  python_path: '/usr/bin/python3',
  pip: 'yes',
  venv: 'yes',
  ansible_path: '/opt/cloudforge/ansible/bin/ansible-playbook',
  ansible_version: 'ansible-playbook [core 2.18.6]',
  memory_mb: '24000',
  disk_mb: '190000',
  coreutils: 'yes',
  dns: 'yes',
  https: 'yes',
  package_lock: 'free',
  time_sync: 'yes',
  firewall: 'ufw:Status: inactive',
  selinux: 'unavailable',
  docker_conflicts: '',
  port_busy: 'no',
  owned_service: 'unknown',
  profile_https: 'yes',
  ss: 'yes',
};

describe('VPS preflight', () => {
  it('checks exact package-manager processes without matching its own command text', () => {
    const command = preflightCommand(9443, 'portainer', 'download.docker.com');
    expect(command).toContain("pgrep -x 'apt|apt-get|dpkg|dnf|yum'");
    expect(command).not.toContain('pgrep -f');
    expect(command).toContain('https://download.docker.com/');
  });

  it('parses only CloudForge fact records', () => {
    expect(parsePreflightOutput('noise\nCF:os_id=ubuntu\nCF:name=value=with=equals')).toEqual({
      os_id: 'ubuntu',
      name: 'value=with=equals',
    });
  });

  it('accepts an Ubuntu 24.04 ARM VPS prepared for Jenkins', () => {
    const report = buildPreflightReport(ready, 'jenkins', 8080);
    expect(report.status).toBe('ready');
    expect(report.facts.architecture).toBe('aarch64');
  });

  it('offers an explicit package repair plan when the managed runtime is absent', () => {
    const report = buildPreflightReport(
      {
        ...ready,
        python_version: '',
        pip: 'no',
        venv: 'no',
        ansible_path: '',
        ansible_version: '',
      },
      'nginx',
      80,
    );
    expect(report.status).toBe('needs-repair');
    expect(report.repairPackages).toContain('python3-venv');
  });

  it('blocks unsupported systems, missing sudo, and conflicting ports', () => {
    const report = buildPreflightReport(
      { ...ready, os_id: 'alpine', privilege: 'none', port_busy: 'yes' },
      'portainer',
      9443,
    );
    expect(report.status).toBe('blocked');
    expect(
      report.checks.filter((check) => check.status === 'blocked').map((check) => check.id),
    ).toEqual(expect.arrayContaining(['os', 'privilege', 'port']));
  });

  it('derives configurable service ports safely', () => {
    expect(profilePort('dockhand', { port: 3100 })).toBe(3100);
    expect(profilePort('jenkins', { port: 99_999 })).toBe(8080);
    expect(profilePort('nginx')).toBe(80);
  });

  it('blocks a profile when its official package repository is unreachable', () => {
    const report = buildPreflightReport({ ...ready, profile_https: 'no' }, 'docker');
    expect(report.status).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'profile-repository')?.message).toContain(
      'download.docker.com',
    );
  });
});
