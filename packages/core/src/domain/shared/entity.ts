/**
 * Base class for domain entities. Entities have a stable identity and are
 * compared by that identity rather than by attribute equality.
 *
 * @typeParam Id - The branded identity type of the entity.
 */
export abstract class Entity<Id> {
  protected constructor(readonly id: Id) {}

  /** Two entities are equal when they share the same concrete type and identity. */
  equals(other: Entity<Id>): boolean {
    return this === other || (other instanceof Entity && other.id === this.id);
  }
}
