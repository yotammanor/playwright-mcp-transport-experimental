const enabledPatterns = (process.env.DEBUG ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

function matches(namespace: string): boolean {
  for (const pattern of enabledPatterns) {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      if (namespace.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === namespace) {
      return true;
    }
  }
  return false;
}

export type Debugger = (message: string, ...args: unknown[]) => void;

export function createDebug(namespace: string): Debugger {
  const active = matches(namespace);
  if (!active) return () => {};
  return (message: string, ...args: unknown[]) => {
    process.stderr.write(`${namespace} ${message} ${args.map((a) => JSON.stringify(a)).join(' ')}\n`);
  };
}
