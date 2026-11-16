/**
 * Keep an existing server on the image it was created from.
 *
 * A plan names its image by operating system ("ubuntu-24.04"), and the program
 * resolves that name to the newest matching image on every run. Once a provider
 * publishes a newer image, the next Apply would move the existing server to it:
 * on Oracle that replaces the boot disk in place, on AWS it replaces the whole
 * instance. Either way everything stored on the server is lost, and it happened
 * to a production server whose plan nobody had changed.
 *
 * So a name only decides the image of a server being created. A plan that pins an
 * exact image id still updates the server when that id changes, because writing
 * a different id is a deliberate act; the preview marks that change destructive.
 */
export function imageChangeOptions(
  image: string,
  pinnedPrefix: string,
  property: string,
): { ignoreChanges?: string[] } {
  return image.trim().startsWith(pinnedPrefix) ? {} : { ignoreChanges: [property] };
}
