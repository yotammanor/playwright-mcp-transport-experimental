import { test as mcpTest, expect } from '../../src/shim/index.js';
import { fileURLToPath } from 'node:url';
import { startStaticServer, type StaticServer } from './static-server.js';

type Fixtures = { fixturesUrl: string };

const test = mcpTest.extend<Fixtures>({
  fixturesUrl: async ({}, use) => {
    let server: StaticServer | undefined;
    try {
      server = await startStaticServer();
      await use(server.url);
    } finally {
      await server?.close();
    }
  },
});

test.describe('shim: Page/Locator-shaped adapter against a real @playwright/mcp server', () => {
  test('navigate, CSS/role/testid locators, form fill + click round-trip', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await expect(page.getByRole('heading', { name: 'Shim Fixture' })).toBeVisible();
    await expect(page.locator('#status')).toBeEmpty();

    await page.getByTestId('name-field').fill('Ada');
    await expect(page.getByTestId('name-field')).toHaveValue('Ada');

    await page.locator('#save-btn').click();
    await expect(page.locator('#status')).toHaveText('Saved: Ada');
    await expect(page.getByText('Saved: Ada')).toBeVisible();
  });

  test('toHaveText/toContainText normalize whitespace like real Playwright (trim + collapse), unlike toHaveValue/toHaveAttribute', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    // Real Playwright's toHaveText trims and collapses whitespace before comparing —
    // rendered HTML routinely carries incidental leading/trailing whitespace.
    await expect(page.locator('#padded-heading')).toHaveText('Padded Heading');
    await expect(page.locator('#padded-heading')).toContainText('Padded');
  });

  test('visibility treats rendered children of display: contents elements as visible', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await expect(page.locator('text="Visible contents"')).toBeVisible();
  });

  test('locator.getByRole()/.getByText() chain within a subtree, like real Playwright', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const body = page.locator('body');
    await expect(body.getByRole('button', { name: 'Save' })).toBeVisible();
    await body.getByRole('textbox').fill('Ada');
    await body.getByRole('button', { name: 'Save' }).click();
    await expect(body.getByText('Saved: Ada')).toBeVisible();
  });

  test('getByLabel and locator has/hasText options preserve real Playwright selector semantics', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const likeButton = page.getByLabel(/like/i);
    await expect(likeButton).toHaveText('Liked');
    await expect(page.locator('.panel', { has: likeButton })).toHaveAttribute('id', 'liked-panel');
    await expect(page.locator('.panel', { hasText: 'Other' })).toHaveAttribute('id', 'other-panel');
    await expect(page.locator('.panel').filter({ has: likeButton })).toHaveAttribute('id', 'liked-panel');
    await expect(likeButton).not.toHaveAttribute('missing', /.*/, { timeout: 1_000 });
  });

  test('page.inputValue and frameLocator delegate to their locator equivalents', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.fill('#name', 'Ada');
    expect(await page.inputValue('#name')).toBe('Ada');
    await expect(page.frameLocator('#fixture-frame').locator('h1')).toHaveText('Inside Frame');
  });

  test('locator.setInputFiles uploads an in-memory payload through MCP', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.locator('#upload').setInputFiles({
      name: 'fixture.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await expect(page.locator('#upload-status')).toHaveText('fixture.txt:5');
    expect(await page.locator('#upload').evaluate(async (input) => input.files?.[0]?.text())).toBe('hello');
  });

  test('waitForEvent(filechooser) captures the chooser created by a click', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#upload').click();
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles(fileURLToPath(new URL('./fixtures/form.html', import.meta.url)));
    await expect(page.locator('#upload-status')).toContainText('form.html:');
  });

  test('the context fixture shares MCP pages and storage with the shim page', async ({ page, context, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    expect(context.pages()).toEqual([page]);
    await context.addCookies([{ name: 'shim-cookie', value: 'present', url: fixturesUrl }]);
    expect(await context.cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'shim-cookie', value: 'present' })]));
    await context.clearCookies();
    expect(await context.cookies()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'shim-cookie' })]));
  });

  test('context.newCDPSession delegates protocol commands to the native page target', async ({ page, context, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const session = await context.newCDPSession(page);
    const result = await session.send('Runtime.evaluate', {
      expression: '6 * 7',
      returnByValue: true,
    });
    expect(result.result.value).toBe(42);
  });

  test('locator.$$eval pierces the root element shadow DOM', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const values = await page.locator('shadow-fixture').$$eval('.inside', (elements) => elements.map((element) => element.textContent));
    expect(values).toEqual(['Shadow value']);
    const host = await page.$('shadow-fixture');
    const inside = await host?.$('.inside');
    expect(await inside?.textContent()).toBe('Shadow value');
    expect(await page.evaluate((element) => element?.textContent, inside)).toBe('Shadow value');
    await expect(inside!).toBeAttached();
    await expect(page.locator('shadow-fixture')).toHaveText('Shadow value');
    const shadowIcon = page.locator('shadow-fixture').locator('#shadow-icon');
    await shadowIcon.click();
    expect(await shadowIcon.innerHTML()).toContain('class="check"');
  });

  test('waitForEvent(console) captures native page messages', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const messagePromise = page.waitForEvent('console', (message) => message.text() === 'shim-console-event');
    await page.evaluate(() => console.log('shim-console-event'));
    const message = await messagePromise;
    expect(message.type()).toBe('log');
  });

  test('console listeners survive navigation and capture init-script logs', async ({ page, fixturesUrl }) => {
    await page.addInitScript('console.log("shim-console-navigation");');
    const firstMessage = page.waitForEvent('console', (message) => message.text() === 'shim-console-navigation');
    await page.goto(`${fixturesUrl}/shim.html?console-navigation=first`);
    await firstMessage;

    const reloadedMessage = page.waitForEvent('console', (message) => message.text() === 'shim-console-navigation');
    await page.reload();
    await reloadedMessage;
  });

  test('pageErrors returns uncaught errors retained by the MCP console log', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.evaluate(() => setTimeout(() => {
      throw new Error('shim-page-error');
    }, 0));
    await expect.poll(async () => (await page.pageErrors()).map((error) => error.message)).toContain('shim-page-error');
  });

  test('toBeDisabled can observe a pending state hidden by MCP action completion', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const button = page.locator('#pending-button');
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).not.toBeDisabled();
  });

  test('text assertions can observe transitions hidden by MCP action completion', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.locator('#transition-button').click();
    await expect(page.locator('#transition-status')).toHaveText('pending');
    await expect(page.locator('#transition-status')).toHaveText('complete');
    await expect(page.locator('html')).toHaveAttribute('data-transient-direction', 'forward');
    await expect(page.locator('html')).not.toHaveAttribute('data-transient-direction');
  });

  test('locator reads and clicks auto-wait, and transient HTML remains observable', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);

    const attribute = page.locator('#late-attribute').getAttribute('data-state');
    const click = page.locator('#late-button').click();
    await expect(attribute).resolves.toBe('ready');
    await click;
    await expect(page.locator('#status')).toHaveText('Late button clicked');

    await page.locator('#html-transition-button').click();
    expect(await page.locator('#html-transition-status').innerHTML()).toContain('class="pending"');
    expect(await page.locator('#html-transition-status').innerHTML()).toContain('class="complete"');
  });

  test('clickCount above two and viewport ratio preserve locator option semantics', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.locator('#multi-click-button').click({ clickCount: 5 });
    await expect(page.locator('#multi-click-status')).toHaveText('5');
    await expect(page.locator('h1')).toBeInViewport({ ratio: 0.9 });
  });

  test('coordinate mouse movement and button state use native pointer input', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const box = await page.locator('#pointer-target').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await expect(page.locator('#pointer-status')).toHaveText('down');
    await page.mouse.up();
    await expect(page.locator('#pointer-status')).toHaveText('up');
  });

  test('legacy page selector actions use the first match and waitForURL accepts globs', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.fill('input', 'first input');
    await expect(page.locator('#name')).toHaveValue('first input');
    await page.type('#name', ' appended');
    await expect(page.locator('#name')).toHaveValue('first input appended');
    await page.evaluate(() => history.pushState({}, '', '/glob-target'));
    await page.waitForURL('**/glob-target');
  });

  test('hover returns before a delayed request and waitForEvent observes it', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.locator('#hover-request').hover();
    await page.waitForEvent('request', {
      predicate: (request) => request.url().includes('hover-request=true'),
      timeout: 10_000,
    });
    expect(requests.some((url) => url.includes('hover-request=true'))).toBe(true);
  });

  test('clicking a non-HTML link returns while the browser navigates', async ({ page, fixturesUrl }) => {
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto(`${fixturesUrl}/shim.html`);
    await expect.poll(() => loads).toBe(1);
    await page.click('#non-html-link');
    expect(await page.evaluate(() => ({ url: location.href, root: document.documentElement.nodeName }))).toEqual({
      url: `${fixturesUrl}/fixture.svg`,
      root: 'HTML',
    });
    await expect(page.locator('svg')).toBeVisible();
    await expect(page).toHaveURL(/fixture\.svg$/);
    await expect.poll(() => loads).toBe(2);
  });

  test('waitForResponse exposes retained response headers and body', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const responsePromise = page.waitForResponse((response) => response.url().includes('/shim.html?network-body=true'));
    await page.evaluate(() => fetch('/shim.html?network-body=true'));
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    expect(await response.text()).toContain('<title>Shim Fixture</title>');
  });

  test('waitForRequest lazily exposes retained request headers and POST data', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.setExtraHTTPHeaders({ 'x-shim-global': 'global' });
    const requestPromise = page.waitForRequest((request) => request.url().includes('request-details=true'));
    await page.evaluate(() =>
      fetch('/shim.html?request-details=true', {
        method: 'POST',
        headers: { 'x-shim-request': 'present' },
        body: JSON.stringify({ value: 42 }),
      }),
    );
    const request = await requestPromise;
    expect(request.method()).toBe('POST');
    expect((await request.allHeaders())['x-shim-request']).toBe('present');
    expect((await request.allHeaders())['x-shim-global']).toBe('global');
    expect(request.postDataJSON()).toEqual({ value: 42 });
  });

  test('route.request() exposes live metadata to observational continue handlers', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const observed: Array<{ method: string; contentType: string | undefined; data: unknown }> = [];
    await page.route('**/shim.html?route-observe=true', async (route) => {
      const request = route.request();
      observed.push({
        method: request.method(),
        contentType: request.headers()['content-type'],
        data: request.postDataJSON(),
      });
      await route.continue();
    });

    await page.evaluate(() =>
      fetch('/shim.html?route-observe=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routed: true }),
      }),
    );

    expect(observed).toEqual([
      {
        method: 'POST',
        contentType: 'application/json',
        data: { routed: true },
      },
    ]);
  });

  test('stateful route handlers preserve sequential abort and continue decisions', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    let attempts = 0;
    await page.route('**/shim.html?route-retry=true', async (route) => {
      attempts++;
      if (attempts === 1) await route.abort('failed');
      else await route.continue();
    });

    const outcomes = await page.evaluate(async () => {
      const first = await fetch('/shim.html?route-retry=true').then(
        () => 'resolved',
        () => 'rejected',
      );
      const second = await fetch('/shim.html?route-retry=true').then((response) => response.status);
      return [first, second];
    });

    expect(outcomes).toEqual(['rejected', 200]);
    expect(attempts).toBe(2);
  });

  test('stateful routes allow a failed module import to retry with a URL fragment', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    let attempts = 0;
    await page.route('**/retry-module.js*', async (route) => {
      attempts++;
      if (attempts === 1) await route.abort('failed');
      else await route.continue();
    });

    const value = await page.evaluate(async () => {
      try {
        await import('/retry-module.js');
      } catch {
        // A fragment produces a distinct module-map entry while preserving the
        // same network URL, matching Astro's hydration recovery strategy.
      }
      return (await import(`/retry-module.js#retry=${Date.now()}`)).retryValue;
    });

    expect(value).toBe('loaded-after-retry');
    expect(attempts).toBe(2);
  });

  test('request listeners baseline retained history before the next page action', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.evaluate(() => fetch('/shim.html?before-listener=true'));

    const observed: string[] = [];
    page.on('request', (request) => observed.push(request.url()));
    const nextRequest = page.waitForRequest('/shim.html?after-listener=true');
    await page.evaluate(() => fetch('/shim.html?after-listener=true'));
    await nextRequest;

    expect(observed.some((url) => url.includes('before-listener=true'))).toBe(false);
    expect(observed.some((url) => url.includes('after-listener=true'))).toBe(true);
  });

  test('waitForEvent(popup) returns a URL-bearing popup facade', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const popupPromise = page.waitForEvent('popup', { timeout: 10_000 });
    const contextPagePromise = page.context().waitForEvent('page', { timeout: 10_000 });
    await page.locator('#popup-link').click();
    const popup = await popupPromise;
    expect(await contextPagePromise).toBe(popup);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('popup=true');
    await expect(popup.locator('h1')).toHaveText('Shim Fixture');
    await expect(page).toHaveURL(/shim\.html$/);
    await popup.close();
  });

  test('context.newPage returns an independently targetable same-context page', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.evaluate(() => {
      document.cookie = 'shim-context=shared; path=/';
    });

    const secondPage = await page.context().newPage();
    await secondPage.goto(`${fixturesUrl}/shim.html?second=true`);
    await expect(secondPage.locator('h1')).toHaveText('Shim Fixture');
    expect(await secondPage.evaluate(() => document.cookie)).toContain('shim-context=shared');

    await expect(page).toHaveURL(/shim\.html$/);
    expect(await page.evaluate(() => location.search)).toBe('');
    expect(page.context().pages()).toHaveLength(2);
    await secondPage.close();
    expect(page.context().pages()).toHaveLength(1);
  });

  test('waitForEvent(download) is captured atomically with its triggering click', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await page.locator('#download-link').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('fixture.txt');
  });

  test('load events include full-page navigations initiated by clicks', async ({ page, fixturesUrl }) => {
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto(`${fixturesUrl}/shim.html`);
    expect(loads).toBe(1);

    const loadPromise = page.waitForEvent('load');
    await page.locator('#reload-link').click();
    await loadPromise;
    expect(loads).toBe(2);
    expect(page.url()).toContain('reloaded=true');
  });

  test('back, forward, and reload return native navigation responses and refresh the URL cache', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html?history=one`);
    await page.goto(`${fixturesUrl}/shim.html?history=two`);

    const backResponse = await page.goBack({ waitUntil: 'load' });
    expect(backResponse?.status()).toBe(200);
    expect(page.url()).toContain('history=one');

    const forwardResponse = await page.goForward({ waitUntil: 'load' });
    expect(forwardResponse?.status()).toBe(200);
    expect(page.url()).toContain('history=two');

    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded' });
    expect(reloadResponse?.headers()['content-type']).toContain('text/html');
  });

  test('multi-element locators: count, first/last/nth, array-form toHaveText', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const items = page.locator('.item');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toHaveText('One');
    await expect(items.last()).toHaveText('Three');
    await expect(items.nth(1)).toHaveText('Two');
    await expect(items).toHaveText(['One', 'Two', 'Three']);
  });

  test.describe('toBeVisible / toBeChecked: {option} and .not. are independent inversion mechanisms', () => {
    // Regression coverage for a real bug: expected-state and the isNot flag were
    // conflated, which happened to work when the only inversion mechanism was
    // `.not.`, and broke the moment an explicit {visible}/{checked} option was
    // added (deriving `expected` from `isNot`, or vice versa, is wrong whenever
    // they disagree — see matchers.ts's docstring on toBeVisible).
    test('plain .toBeVisible() / .not.toBeVisible()', async ({ page, fixturesUrl }) => {
      await page.goto(`${fixturesUrl}/shim.html`);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('#does-not-exist')).not.toBeVisible({ timeout: 1_000 });
    });

    test('{visible: true} and {visible: false}, without .not.', async ({ page, fixturesUrl }) => {
      await page.goto(`${fixturesUrl}/shim.html`);
      await expect(page.locator('h1')).toBeVisible({ visible: true });
      await expect(page.locator('#does-not-exist')).toBeVisible({ visible: false, timeout: 1_000 });
    });

    test('plain .toBeChecked() / .not.toBeChecked()', async ({ page, fixturesUrl }) => {
      await page.goto(`${fixturesUrl}/shim.html`);
      const checkbox = page.locator('#agree');
      await expect(checkbox).toBeChecked();
      await checkbox.uncheck();
      await expect(checkbox).not.toBeChecked();
    });

    test('{checked: true} and {checked: false}, without .not.', async ({ page, fixturesUrl }) => {
      await page.goto(`${fixturesUrl}/shim.html`);
      const checkbox = page.locator('#agree');
      await expect(checkbox).toBeChecked({ checked: true });
      await checkbox.uncheck();
      await expect(checkbox).toBeChecked({ checked: false });
    });
  });

  test('toBeEditable supports editable inputs and readonly transitions', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const input = page.locator('#name');
    await expect(input).toBeEditable();
    await input.evaluate((element) => {
      (element as HTMLInputElement).readOnly = true;
    });
    await expect(input).toBeEditable({ editable: false });
    await expect(input).not.toBeEditable();
  });

  test('goto() returns a Response-shaped object; page.url() is synchronous', async ({ page, fixturesUrl }) => {
    const response = await page.goto(`${fixturesUrl}/shim.html`);
    expect(response.status()).toBeGreaterThanOrEqual(200);
    expect(response.status()).toBeLessThan(400);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/html');
    expect((await response.allHeaders())['content-type']).toContain('text/html');
    expect(await response.headerValue('Content-Type')).toContain('text/html');
    expect(page.url()).toContain('shim.html'); // synchronous, no await
    await expect(page).toHaveURL((url) => url.pathname.endsWith('/shim.html'));
  });

  test('evaluate() accepts a real function with an argument (page-level and element-scoped)', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const sum = await page.evaluate(({ a, b }) => a + b, { a: 2, b: 3 });
    expect(sum).toBe(5);

    await page.evaluate((name) => (window as unknown as { greet: (n: string) => void }).greet(name), 'Ada');
    await expect(page.locator('#status')).toHaveText('Hi Ada');

    const tag = await page.locator('h1').evaluate((el) => el.tagName);
    expect(tag).toBe('H1');
  });

  test('locator.dispatchEvent, .clear(), and .scrollIntoViewIfNeeded() do not throw', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const input = page.locator('#name');
    await input.fill('temp');
    await input.dispatchEvent('blur');
    await input.clear();
    await expect(input).toHaveValue('');
    await input.scrollIntoViewIfNeeded();
    await page.locator('#pointer-target').dispatchEvent('touchstart');
    await expect(page.locator('#pointer-status')).toHaveText('touch');
  });

  test('page.$$() returns per-element locators', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const items = await page.$$('.item');
    expect(items).toHaveLength(3);
    expect(await items[1]!.textContent()).toBe('Two');
  });

  test('page.waitForSelector uses the first match unless strict mode is requested', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const item = await page.waitForSelector('.item');
    expect(await item.first().textContent()).toBe('One');
    await expect(page.waitForSelector('.item', { strict: true, timeout: 0 })).rejects.toThrow(
      'strict mode violation',
    );
  });

  test('page.request.get() delegates to the managed APIRequestContext', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const response = await page.request.get(`${fixturesUrl}/shim.html`);
    expect(response.status()).toBe(200);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('Shim Fixture');
  });

  test('page.request before navigation leaves the browser page at about:blank', async ({ page, fixturesUrl }) => {
    const response = await page.request.get(`${fixturesUrl}/shim.html`);
    expect(response.status()).toBe(200);
    expect(await page.evaluate(() => location.href)).toBe('about:blank');
  });

  test('page.request preserves string bodies, query params, and maxRedirects: 0', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    const echo = await page.request.post(`${fixturesUrl}/echo`, {
      data: 'raw-body',
      params: { mode: 'test', id: 42 },
    });
    expect(await echo.json()).toEqual({
      body: 'raw-body',
      url: '/echo?mode=test&id=42',
    });

    const form = await page.request.post(`${fixturesUrl}/echo`, {
      form: { grant_type: 'refresh_token', client_id: 'shim-client' },
    });
    const formEcho = (await form.json()) as { body: string };
    expect(Object.fromEntries(new URLSearchParams(formEcho.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'shim-client',
    });

    const redirect = await page.request.get(`${fixturesUrl}/redirect`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect((await redirect.allHeaders()).location).toBe('/shim.html');
  });

  test('page.waitForFunction() polls until truthy', async ({ page, fixturesUrl }) => {
    await page.goto(`${fixturesUrl}/shim.html`);
    await page.evaluate(() => {
      setTimeout(() => {
        (window as unknown as { ready: boolean }).ready = true;
      }, 300);
    });
    const result = await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
    expect(result).toBe(true);
  });

  test('page.addInitScript() runs before scripts in future documents', async ({ page, fixturesUrl }) => {
    await page.addInitScript('window.__shimInitValue = "ready";');
    await page.goto(`${fixturesUrl}/shim.html?init-script=true`);
    expect(await page.evaluate(() => (window as unknown as { __shimInitValue?: string }).__shimInitValue)).toBe('ready');
  });
});

test.describe('shim: project context options', () => {
  test.use({
    locale: 'fr-FR',
    timezoneId: 'America/New_York',
    viewport: { width: 913, height: 617 },
  });

  test('forwards Playwright project use options to the MCP browser context', async ({ page }) => {
    const context = await page.evaluate(() => ({
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: { width: innerWidth, height: innerHeight },
    }));

    expect(context).toEqual({
      locale: 'fr-FR',
      timezone: 'America/New_York',
      viewport: { width: 913, height: 617 },
    });
  });
});
