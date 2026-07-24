import { newUuid, UnauthorizedError } from '@cloudforge/shared';

export interface ProjectSessionLease {
  readonly projectId: string;
  readonly sessionId: string;
  readonly generation: number;
}

/** Read side consumed by repositories and project-scoped application services. */
export interface ProjectContext {
  current(): ProjectSessionLease | null;
  requireActive(): ProjectSessionLease;
  isCurrent(lease: ProjectSessionLease): boolean;
}

/** Mutation side kept inside the project-session application service. */
export interface ProjectContextController extends ProjectContext {
  activate(projectId: string): ProjectSessionLease;
  clear(): void;
}

/** Process-local context. It contains no passkeys or decrypted secret material. */
export class InMemoryProjectContext implements ProjectContextController {
  private active: ProjectSessionLease | null = null;
  private generation = 0;

  current(): ProjectSessionLease | null {
    return this.active;
  }

  requireActive(): ProjectSessionLease {
    if (!this.active) throw new UnauthorizedError('Unlock a project to continue');
    return this.active;
  }

  isCurrent(lease: ProjectSessionLease): boolean {
    return (
      this.active?.projectId === lease.projectId &&
      this.active.sessionId === lease.sessionId &&
      this.active.generation === lease.generation
    );
  }

  activate(projectId: string): ProjectSessionLease {
    this.generation += 1;
    this.active = {
      projectId,
      sessionId: newUuid(),
      generation: this.generation,
    };
    return this.active;
  }

  clear(): void {
    this.generation += 1;
    this.active = null;
  }
}
