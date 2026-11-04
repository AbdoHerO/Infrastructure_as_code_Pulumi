import type { ProjectContext, StackRecord, StackStore } from '@cloudforge/core';
import type { Db } from '../client.js';
import { PrismaProjectListStore } from './prisma-project-list-store.js';

/** Docker stack records; the Compose file and `.env` are an encrypted credential. */
export class PrismaStackStore extends PrismaProjectListStore<StackRecord> implements StackStore {
  constructor(db: Db, context: ProjectContext) {
    super(db, context, 'stacks:list', 'Docker stacks');
  }
}
