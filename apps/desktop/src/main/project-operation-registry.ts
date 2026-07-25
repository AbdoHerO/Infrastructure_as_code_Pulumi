interface ActiveProjectOperation {
  readonly key: string;
  readonly projectId: string;
  readonly controller: AbortController | null;
  readonly completed: Promise<void>;
  complete(): void;
}

export interface ProjectOperationLease {
  readonly signal: AbortSignal | undefined;
  complete(): void;
}

/**
 * Process-wide registry for work that must not survive a workspace switch.
 *
 * Abortable SSH work is cancelled and drained. Provider operations such as a
 * Pulumi apply are deliberately non-abortable here: switching projects while
 * one is running is refused instead of allowing late state to enter another
 * workspace.
 */
export class ProjectOperationRegistry {
  private readonly active = new Map<string, ActiveProjectOperation>();

  begin(key: string, projectId: string, abortable: boolean): ProjectOperationLease {
    if (this.active.has(key)) throw new Error(`Operation "${key}" is already active`);
    const controller = abortable ? new AbortController() : null;
    let resolveCompleted = (): void => undefined;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const operation: ActiveProjectOperation = {
      key,
      projectId,
      controller,
      completed,
      complete: () => {
        if (this.active.get(key) !== operation) return;
        this.active.delete(key);
        resolveCompleted();
      },
    };
    this.active.set(key, operation);
    return {
      signal: controller?.signal,
      complete: operation.complete,
    };
  }

  cancel(key: string): void {
    this.active.get(key)?.controller?.abort();
  }

  async deactivate(projectId: string): Promise<void> {
    const operations = [...this.active.values()].filter(
      (operation) => operation.projectId === projectId,
    );
    const blockers = operations.filter((operation) => operation.controller === null);
    if (blockers.length > 0) {
      throw new Error(
        `Wait for the active operation to finish before switching projects: ${blockers
          .map((operation) => operation.key)
          .join(', ')}`,
      );
    }
    for (const operation of operations) operation.controller?.abort();
    await Promise.all(operations.map((operation) => operation.completed));
  }
}

export const projectOperations = new ProjectOperationRegistry();
