/**
 * Tools that read or write files on this computer, for the "Use this computer"
 * permission. `true` means every call does; otherwise the call does when one of
 * the named arguments is given. A tool's tier says how dangerous its effect is, so
 * this is a separate check: `backup_create_project` is an ordinary change that
 * also happens to choose where a file goes.
 */
const LOCAL_FILE_TOOLS: Readonly<Record<string, true | readonly string[]>> = {
  credentials_import_environment_file: true,
  ssh_keys_export_private: true,
  backup_create_project: true,
  backup_restore_project: true,
  backup_import_project: true,
  stacks_read_folder: true,
  ssh_keys_import: ['privateKeyPath'],
  stacks_create: ['folderPath'],
  stacks_update: ['folderPath'],
  ssl_export_certificate: ['savePath'],
  ssl_export_private_key: ['savePath'],
};

/** Whether every call to this tool uses local files, so it can be hidden outright. */
export function alwaysUsesLocalFiles(tool: string): boolean {
  return LOCAL_FILE_TOOLS[tool] === true;
}

/** Whether this particular call reads or writes a file on this computer. */
export function usesLocalFiles(tool: string, input: unknown): boolean {
  const rule = LOCAL_FILE_TOOLS[tool];
  if (rule === undefined) return false;
  if (rule === true) return true;
  const values = input as Readonly<Record<string, unknown>>;
  return rule.some((argument) => values[argument] !== undefined);
}

/** Every tool named here, for the test that compares this list with the catalogue. */
export function localFileToolNames(): string[] {
  return Object.keys(LOCAL_FILE_TOOLS);
}
