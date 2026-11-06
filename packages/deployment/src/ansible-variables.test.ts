import { describe, expect, it } from 'vitest';
import type { AnsibleProfile } from '@cloudforge/core';
import { validateVariables } from './ssh-ansible-manager.js';

const profile = {
  id: 'postgres',
  name: 'PostgreSQL',
  description: '',
  variables: [
    { key: 'database_name', label: 'Database name', type: 'string', required: true },
    {
      key: 'database_password',
      label: 'Database password',
      type: 'string',
      required: true,
      secret: true,
    },
  ],
} as unknown as AnsibleProfile;

describe('validateVariables', () => {
  it('needs a required secret when installing', () => {
    const result = validateVariables(profile, { database_name: 'app' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Database password is required');
  });

  it('does not need a secret when reading it back from the server', () => {
    const result = validateVariables(profile, { database_name: 'app' }, { secretsRequired: false });
    expect(result.ok).toBe(true);
  });

  it('still needs everything that is not a secret', () => {
    const result = validateVariables(profile, {}, { secretsRequired: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Database name is required');
  });
});
