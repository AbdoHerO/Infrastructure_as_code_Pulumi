import type { ProjectContext, WordPressSiteRecord, WordPressSiteStore } from '@cloudforge/core';
import type { Db } from '../client.js';
import { PrismaProjectListStore } from './prisma-project-list-store.js';

/** WordPress site records; the passwords are a separate encrypted credential. */
export class PrismaWordPressSiteStore
  extends PrismaProjectListStore<WordPressSiteRecord>
  implements WordPressSiteStore
{
  constructor(db: Db, context: ProjectContext) {
    super(db, context, 'wordpress:sites', 'WordPress sites');
  }
}
