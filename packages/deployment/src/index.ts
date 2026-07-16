/**
 * `@cloudforge/deployment` — the deployment engine.
 *
 * Implements the `Deployer` port from `@cloudforge/core`, executing deployment
 * steps over SSH. An Ansible-playbook deployer can be added behind the same port.
 */
export { SshDeployer } from './ssh-deployer.js';
export { NodeSshKeyGenerator } from './node-ssh-key-generator.js';
export { SshContainerManager } from './ssh-container-manager.js';
export { SshAnsibleManager } from './ssh-ansible-manager.js';
export { SshNginxManager } from './ssh-nginx-manager.js';
export { SshCertificateManager } from './ssh-certificate-manager.js';
export { NodeSshTerminalManager } from './ssh-terminal-manager.js';
export { JenkinsHttpManager } from './jenkins-http-manager.js';
export * from './host-firewall-script.js';
export { AnsibleNativeServiceRequirements } from './ansible-native-service-requirements.js';
export { SshHostFirewallManager } from './ssh-host-firewall-manager.js';
export { SshRuntimeApplier, commandFor } from './ssh-runtime-applier.js';
export { SshRuntimeInspector } from './ssh-runtime-inspector.js';
export {
  parseContainerPorts,
  parseContainers,
  parseJsonLines,
  parseNetworks,
  parseVolumes,
} from './docker-inspect.js';

// Shared SSH transport primitives. Every adapter in this package builds on these
// rather than hand-rolling its own connect/exec/fingerprint/quote logic.
export {
  base64,
  execCommand,
  fingerprintHostKey,
  inspectHostKeyFingerprint,
  normalizeFingerprint,
  privilegedScript,
  quote,
  runPrivilegedScript,
  SSH_CONNECT_TIMEOUT_MS,
  sshConnectionConfig,
  uploadFile,
  withSshConnection,
} from './ssh-transport.js';
export type {
  SshCommandOutput,
  SshEvent,
  SshEventSink,
  SshExecOptions,
  SshOperationOptions,
} from './ssh-transport.js';
