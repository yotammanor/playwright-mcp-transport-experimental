export type TextPattern = string | RegExp;
export type GetByRoleOptions = { name?: TextPattern; exact?: boolean };
export type GetByTextOptions = { exact?: boolean };

function escapeRegexForSelector(value: RegExp): string {
  if (value.unicode || (value as RegExp & { unicodeSets?: boolean }).unicodeSets) return String(value);
  return String(value)
    .replace(/(^|[^\\])(\\\\)*(["'`])/g, '$1$2\\$3')
    .replace(/>>/g, '\\>\\>');
}

export function escapeForTextSelector(value: TextPattern, exact: boolean): string {
  return typeof value === 'string' ? `${JSON.stringify(value)}${exact ? 's' : 'i'}` : escapeRegexForSelector(value);
}

/**
 * Builds the Playwright selector-engine string for each `getBy*` convenience
 * method — shared by ShimPage and ShimLocator (real Playwright exposes these
 * on both: `page.getByRole(...)` and `locator.getByRole(...)` to search
 * within a subtree) so the two don't duplicate the same string-building logic.
 */
export function roleSelector(role: string, options?: GetByRoleOptions): string {
  if (options?.name === undefined) return `role=${role}`;
  return `role=${role}[name=${escapeForTextSelector(options.name, options.exact ?? false)}]`;
}

export function textSelector(text: TextPattern, options?: GetByTextOptions): string {
  if (text instanceof RegExp) return `text=${escapeRegexForSelector(text)}`;
  return options?.exact ? `text=${JSON.stringify(text)}` : `text=${text}`;
}

export function testIdSelector(id: string): string {
  return `[data-testid=${JSON.stringify(id)}]`;
}

export function placeholderSelector(text: string): string {
  return `[placeholder=${JSON.stringify(text)}]`;
}

export function altTextSelector(text: string): string {
  return `[alt=${JSON.stringify(text)}]`;
}

export function titleSelector(text: string): string {
  return `[title=${JSON.stringify(text)}]`;
}

/** Uses Playwright's own internal label selector, preserving aria-label and label->control association semantics. */
export function labelSelector(text: TextPattern, options?: GetByTextOptions): string {
  return `internal:label=${escapeForTextSelector(text, options?.exact ?? false)}`;
}
