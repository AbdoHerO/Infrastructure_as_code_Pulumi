import type { AnsibleProfile, AnsibleProfileId } from '@cloudforge/core';

export const ANSIBLE_PROFILES: readonly AnsibleProfile[] = [
  {
    id: 'docker',
    name: 'Docker Engine',
    description: 'Install Docker Engine and the Compose plugin, then enable the service.',
    variables: [
      {
        key: 'docker_users',
        label: 'Docker users',
        type: 'string',
        required: false,
        defaultValue: '',
        description: 'Comma-separated users to add to the docker group.',
      },
    ],
  },
  {
    id: 'dockhand',
    name: 'Dockhand',
    description: 'Run Dockhand as a Docker Compose service with persistent data.',
    variables: [
      {
        key: 'service_port',
        label: 'Web port',
        type: 'number',
        required: true,
        defaultValue: 3000,
      },
      {
        key: 'image',
        label: 'Image',
        type: 'string',
        required: true,
        defaultValue: 'fnsys/dockhand:latest',
      },
    ],
  },
  {
    id: 'portainer',
    name: 'Portainer CE',
    description: 'Run Portainer CE with TLS on a configurable host port.',
    variables: [
      {
        key: 'service_port',
        label: 'HTTPS port',
        type: 'number',
        required: true,
        defaultValue: 9443,
      },
      {
        key: 'image',
        label: 'Image',
        type: 'string',
        required: true,
        defaultValue: 'portainer/portainer-ce:lts',
      },
    ],
  },
  {
    id: 'jenkins',
    name: 'Jenkins',
    description: 'Install the current Jenkins LTS package and Java runtime as a native service.',
    variables: [
      {
        key: 'service_port',
        label: 'HTTP port',
        type: 'number',
        required: true,
        defaultValue: 8080,
      },
    ],
  },
  {
    id: 'nginx',
    name: 'Nginx',
    description: 'Install and enable a clean native Nginx service. Domains are managed separately.',
    variables: [],
  },
] as const;

const HEADER = `---
- name: CloudForge managed profile
  hosts: localhost
  connection: local
  become: true
  gather_facts: true
  vars:
    ansible_python_interpreter: /usr/bin/python3
  tasks:
`;

const DOCKER = `${HEADER}
    - name: Install Docker repository prerequisites on Debian family
      ansible.builtin.apt:
        name: [ca-certificates, curl]
        state: present
        update_cache: true
      when: ansible_os_family == 'Debian'
    - name: Create APT keyring directory
      ansible.builtin.file:
        path: /etc/apt/keyrings
        state: directory
        mode: '0755'
      when: ansible_os_family == 'Debian'
    - name: Install Docker repository signing key
      ansible.builtin.get_url:
        url: "https://download.docker.com/linux/{{ ansible_distribution | lower }}/gpg"
        dest: /etc/apt/keyrings/docker.asc
        mode: '0644'
      when: ansible_os_family == 'Debian'
    - name: Read Debian architecture
      ansible.builtin.command: dpkg --print-architecture
      register: docker_deb_arch
      changed_when: false
      when: ansible_os_family == 'Debian'
    - name: Configure Docker APT repository
      ansible.builtin.apt_repository:
        repo: "deb [arch={{ docker_deb_arch.stdout }} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/{{ ansible_distribution | lower }} {{ ansible_distribution_release }} stable"
        filename: docker
        state: present
      when: ansible_os_family == 'Debian'
    - name: Install official Docker packages on Debian family
      ansible.builtin.apt:
        name: [docker-ce, docker-ce-cli, containerd.io, docker-buildx-plugin, docker-compose-plugin]
        state: present
        update_cache: true
      when: ansible_os_family == 'Debian'
    - name: Install Docker repository prerequisites on Red Hat family
      ansible.builtin.package:
        name: dnf-plugins-core
        state: present
      when: ansible_os_family == 'RedHat'
    - name: Configure official Docker repository on Red Hat family
      ansible.builtin.get_url:
        url: "https://download.docker.com/linux/{{ 'rhel' if ansible_distribution == 'RedHat' else 'centos' }}/docker-ce.repo"
        dest: /etc/yum.repos.d/docker-ce.repo
        mode: '0644'
      when: ansible_os_family == 'RedHat'
    - name: Install official Docker packages on Red Hat family
      ansible.builtin.package:
        name: [docker-ce, docker-ce-cli, containerd.io, docker-buildx-plugin, docker-compose-plugin]
        state: present
      when: ansible_os_family == 'RedHat'
    - name: Create Docker systemd override directory on Red Hat family
      ansible.builtin.file:
        path: /etc/systemd/system/docker.service.d
        state: directory
        mode: '0755'
      when: ansible_os_family == 'RedHat'
    - name: Start Docker after firewalld on Red Hat family
      ansible.builtin.copy:
        dest: /etc/systemd/system/docker.service.d/cloudforge-firewalld.conf
        mode: '0644'
        content: |
          [Unit]
          After=network-online.target firewalld.service
          Wants=network-online.target
      register: docker_systemd_override
      when: ansible_os_family == 'RedHat'
    - name: Reload systemd after Docker ordering change
      ansible.builtin.systemd:
        daemon_reload: true
      when: docker_systemd_override is changed
    - name: Enable Docker
      ansible.builtin.service:
        name: docker
        state: started
        enabled: true
    - name: Remove stale CloudForge Docker network probe
      ansible.builtin.command: docker network rm cloudforge-network-probe
      register: docker_probe_cleanup
      changed_when: docker_probe_cleanup.rc == 0
      failed_when: false
    - name: Verify Docker bridge networking
      ansible.builtin.command: docker network create --driver bridge cloudforge-network-probe
      register: docker_network_probe
      changed_when: docker_network_probe.rc == 0
      failed_when: false
    - name: Repair Docker firewall chains after a firewalld startup race
      ansible.builtin.service:
        name: docker
        state: restarted
      when:
        - docker_network_probe.rc != 0
        - ansible_os_family == 'RedHat'
        - >-
          'DOCKER-FORWARD' in docker_network_probe.stderr or
          'Failed to Setup IP tables' in docker_network_probe.stderr or
          'No chain/target/match' in docker_network_probe.stderr
    - name: Retry Docker bridge networking after firewall repair
      ansible.builtin.command: docker network create --driver bridge cloudforge-network-probe
      register: docker_network_retry
      changed_when: docker_network_retry.rc == 0
      when: docker_network_probe.rc != 0
    - name: Remove CloudForge Docker network probe
      ansible.builtin.command: docker network rm cloudforge-network-probe
      changed_when: false
    - name: Add selected users to Docker group
      ansible.builtin.user:
        name: "{{ item }}"
        groups: docker
        append: true
      loop: "{{ docker_users | default('') | split(',') | map('trim') | reject('equalto', '') | list }}"
`;

const DOCKHAND = `${HEADER}
    - name: Verify Docker Compose
      ansible.builtin.command: docker compose version
      changed_when: false
    - name: Create Dockhand directory
      ansible.builtin.file:
        path: /opt/cloudforge/apps/dockhand
        state: directory
        mode: '0755'
    - name: Write Dockhand Compose definition
      ansible.builtin.copy:
        dest: /opt/cloudforge/apps/dockhand/compose.yaml
        mode: '0644'
        content: |
          services:
            dockhand:
              image: "{{ image }}"
              container_name: dockhand
              restart: unless-stopped
              ports:
                - "{{ service_port }}:3000"
              volumes:
                - /var/run/docker.sock:/var/run/docker.sock
                - dockhand_data:/app/data
          volumes:
            dockhand_data:
    - name: Start Dockhand
      ansible.builtin.command: docker compose up -d --remove-orphans
      args:
        chdir: /opt/cloudforge/apps/dockhand
      register: compose_result
      changed_when: "'Started' in compose_result.stdout or 'Created' in compose_result.stdout or 'Recreated' in compose_result.stdout"
`;

const PORTAINER = `${HEADER}
    - name: Verify Docker Compose
      ansible.builtin.command: docker compose version
      changed_when: false
    - name: Create Portainer directory
      ansible.builtin.file:
        path: /opt/cloudforge/apps/portainer
        state: directory
        mode: '0755'
    - name: Write Portainer Compose definition
      ansible.builtin.copy:
        dest: /opt/cloudforge/apps/portainer/compose.yaml
        mode: '0644'
        content: |
          services:
            portainer:
              image: "{{ image }}"
              container_name: portainer
              restart: unless-stopped
              ports:
                - "{{ service_port }}:9443"
              volumes:
                - /var/run/docker.sock:/var/run/docker.sock
                - portainer_data:/data
          volumes:
            portainer_data:
    - name: Start Portainer
      ansible.builtin.command: docker compose up -d --remove-orphans
      args:
        chdir: /opt/cloudforge/apps/portainer
      register: compose_result
      changed_when: "'Started' in compose_result.stdout or 'Created' in compose_result.stdout or 'Recreated' in compose_result.stdout"
`;

const JENKINS = `${HEADER}
    - name: Install Java and prerequisites on Debian family
      ansible.builtin.apt:
        name: [fontconfig, openjdk-21-jre, curl, gnupg, python3-debian]
        state: present
        update_cache: true
      when: ansible_facts['os_family'] == 'Debian'
    - name: Create APT keyring directory for Jenkins
      ansible.builtin.file:
        path: /etc/apt/keyrings
        state: directory
        mode: '0755'
      when: ansible_facts['os_family'] == 'Debian'
    - name: Add Jenkins signing key on Debian family
      ansible.builtin.get_url:
        url: https://pkg.jenkins.io/debian-stable/jenkins.io-2026.key
        dest: /etc/apt/keyrings/jenkins-keyring.asc
        mode: '0644'
      when: ansible_facts['os_family'] == 'Debian'
    - name: Remove legacy Jenkins repository definition
      ansible.builtin.file:
        path: /etc/apt/sources.list.d/jenkins.list
        state: absent
      when: ansible_facts['os_family'] == 'Debian'
    - name: Add Jenkins repository on Debian family
      ansible.builtin.deb822_repository:
        name: jenkins
        types: [deb]
        uris: https://pkg.jenkins.io/debian-stable
        suites: [binary/]
        signed_by: /etc/apt/keyrings/jenkins-keyring.asc
        state: present
      when: ansible_facts['os_family'] == 'Debian'
    - name: Install Jenkins on Debian family
      ansible.builtin.apt:
        name: jenkins
        state: present
        update_cache: true
      when: ansible_facts['os_family'] == 'Debian'
    - name: Install Java on Red Hat family
      ansible.builtin.package:
        name: java-21-openjdk
        state: present
      when: ansible_facts['os_family'] == 'RedHat'
    - name: Add Jenkins repository on Red Hat family
      ansible.builtin.get_url:
        url: https://pkg.jenkins.io/redhat-stable/jenkins.repo
        dest: /etc/yum.repos.d/jenkins.repo
        mode: '0644'
      when: ansible_facts['os_family'] == 'RedHat'
    - name: Import Jenkins key on Red Hat family
      ansible.builtin.rpm_key:
        key: https://pkg.jenkins.io/redhat-stable/jenkins.io-2026.key
        state: present
      when: ansible_facts['os_family'] == 'RedHat'
    - name: Install Jenkins on Red Hat family
      ansible.builtin.package:
        name: jenkins
        state: present
      when: ansible_facts['os_family'] == 'RedHat'
    - name: Create Jenkins systemd override directory
      ansible.builtin.file:
        path: /etc/systemd/system/jenkins.service.d
        state: directory
        mode: '0755'
    - name: Configure Jenkins port through systemd
      ansible.builtin.copy:
        dest: /etc/systemd/system/jenkins.service.d/cloudforge.conf
        mode: '0644'
        content: |
          [Service]
          Environment="JENKINS_PORT={{ service_port }}"
      notify: Restart Jenkins
    - name: Enable Jenkins
      ansible.builtin.service:
        name: jenkins
        state: started
        enabled: true
  handlers:
    - name: Restart Jenkins
      ansible.builtin.systemd_service:
        name: jenkins
        state: restarted
        daemon_reload: true
`;

const NGINX = `${HEADER}
    - name: Install Nginx
      ansible.builtin.package:
        name: nginx
        state: present
    - name: Validate Nginx base configuration
      ansible.builtin.command: nginx -t
      changed_when: false
    - name: Enable Nginx
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true
`;

const PLAYBOOKS: Readonly<Record<AnsibleProfileId, string>> = {
  docker: DOCKER,
  dockhand: DOCKHAND,
  portainer: PORTAINER,
  jenkins: JENKINS,
  nginx: NGINX,
};

export function getPlaybook(id: AnsibleProfileId): string {
  return PLAYBOOKS[id];
}
