import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { ProjectInfrastructureSummary, ProjectSummaryReader } from '@cloudforge/core';
import type { Db } from '../client.js';

/** Safe aggregate projection used before a workspace is unlocked. */
export class PrismaProjectSummaryReader implements ProjectSummaryReader {
  constructor(private readonly db: Db) {}

  async readAll(): Promise<
    Result<ReadonlyMap<string, ProjectInfrastructureSummary>, PersistenceError>
  > {
    try {
      const [projects, targets, pipelines, deployments, plans] = await Promise.all([
        this.db.project.findMany({ select: { id: true } }),
        this.db.vpsTarget.groupBy({ by: ['projectId'], _count: { _all: true } }),
        this.db.jenkinsPipeline.groupBy({ by: ['projectId'], _count: { _all: true } }),
        this.db.deployment.groupBy({ by: ['projectId'], _count: { _all: true } }),
        this.db.setting.findMany({
          where: { key: { startsWith: 'plan:' } },
          select: { projectId: true },
        }),
      ]);
      const targetCounts = new Map(targets.map((row) => [row.projectId, row._count._all]));
      const pipelineCounts = new Map(pipelines.map((row) => [row.projectId, row._count._all]));
      const deploymentCounts = new Map(deployments.map((row) => [row.projectId, row._count._all]));
      const configured = new Set(plans.map((row) => row.projectId));
      return ok(
        new Map(
          projects.map(({ id }) => [
            id,
            {
              infrastructureConfigured: configured.has(id),
              targetCount: targetCounts.get(id) ?? 0,
              pipelineCount: pipelineCounts.get(id) ?? 0,
              deploymentCount: deploymentCounts.get(id) ?? 0,
            },
          ]),
        ),
      );
    } catch (cause) {
      return err(new PersistenceError('Failed to summarize projects', { cause }));
    }
  }
}
