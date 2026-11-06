const SECRET_KEY = /pass|secret|token|private|apikey|api_key|content|environment|compose|data$/i;
const MASK = '••••••••';
const MAX_VALUE_LENGTH = 200;

function mask(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key) && value !== undefined && value !== null && value !== '') return MASK;
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  }
  if (Array.isArray(value)) return value.map((item) => mask(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mask(item, name)]),
    );
  }
  return value;
}

/** Arguments with anything that might be secret hidden, safe to show or log. */
export function maskArguments(input: unknown): unknown {
  return mask(input);
}

/** What a critical call would do, for the person deciding whether to allow it. */
export function describeCall(description: string, input: unknown): string {
  const details = maskArguments(input);
  const empty = !details || (typeof details === 'object' && Object.keys(details).length === 0);
  return empty ? description : `${description}\n\n${JSON.stringify(details, null, 2)}`;
}
