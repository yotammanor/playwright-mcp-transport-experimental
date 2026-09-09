import { expect, test } from '@playwright/test';
import { ShimLocator } from '../../src/shim/locator.js';
import { FakeMcpToolClient, textResult, toolDef } from './helpers/fake-client.js';

test.describe('ShimLocator Playwright semantics', () => {
  test('getAttribute auto-waits for a locator that appears late', async () => {
    let attempts = 0;
    const client = new FakeMcpToolClient([toolDef('browser_evaluate')], {
      browser_evaluate: () => {
        attempts++;
        if (attempts === 1) throw new Error('"#late" does not match any elements');
        return textResult('### Result\n{"value":"ready","url":"http://127.0.0.1/"}');
      },
    });
    const locator = new ShimLocator(client, '#late');

    await expect(locator.getAttribute('data-state', { timeout: 500 })).resolves.toBe('ready');
    expect(attempts).toBe(2);
  });

  test('getAttribute timeout zero performs one immediate observation', async () => {
    const client = new FakeMcpToolClient([toolDef('browser_evaluate')], {
      browser_evaluate: () => {
        throw new Error('"#missing" does not match any elements');
      },
    });
    const locator = new ShimLocator(client, '#missing');

    await expect(locator.getAttribute('data-state', { timeout: 0 })).rejects.toThrow(
      'did not match any elements',
    );
    expect(client.calls).toHaveLength(1);
  });

  test('count uses the client timeout instead of imposing a five-second ceiling', async () => {
    const client = new FakeMcpToolClient([toolDef('browser_evaluate')], {
      browser_evaluate: () => textResult('### Result\ntrue'),
    });
    const locator = new ShimLocator(client, '.item');

    await expect(locator.count()).resolves.toBe(1);
    expect(client.calls[0]?.options?.timeoutMs).toBeUndefined();
  });

  test('click auto-waits before installing its transient-state observer', async () => {
    let evaluateAttempts = 0;
    const client = new FakeMcpToolClient(
      [toolDef('browser_evaluate'), toolDef('browser_run_code_unsafe')],
      {
        browser_evaluate: () => {
          evaluateAttempts++;
          if (evaluateAttempts === 1) throw new Error('"#late-button" does not match any elements');
          return textResult('### Result\n{"value":true,"url":"http://127.0.0.1/"}');
        },
        browser_run_code_unsafe: () => textResult('clicked'),
      },
    );
    const locator = new ShimLocator(client, '#late-button');

    await locator.click({ timeout: 500 });

    expect(evaluateAttempts).toBe(2);
    expect(client.calls.at(-1)?.name).toBe('browser_run_code_unsafe');
  });

  test('native locator hover auto-waits before invoking the managed page', async () => {
    let evaluateAttempts = 0;
    const client = new FakeMcpToolClient(
      [toolDef('browser_evaluate'), toolDef('browser_run_code_unsafe')],
      {
        browser_evaluate: () => {
          evaluateAttempts++;
          if (evaluateAttempts === 1) throw new Error('"#late-hover" does not match any elements');
          return textResult('### Result\n{"value":true,"url":"http://127.0.0.1/"}');
        },
        browser_run_code_unsafe: () => textResult('hovered'),
      },
    );
    const locator = new ShimLocator(client, '#late-hover');

    await locator.hover({ timeout: 500 });

    expect(evaluateAttempts).toBe(2);
    expect(client.calls.at(-1)?.name).toBe('browser_run_code_unsafe');
    expect(String(client.calls.at(-1)?.args.code)).toContain('.hover(');
  });

  test('pressSequentially and blur expose their Playwright locator counterparts', async () => {
    const client = new FakeMcpToolClient(
      [toolDef('browser_evaluate'), toolDef('browser_run_code_unsafe')],
      {
        browser_evaluate: () =>
          textResult('### Result\n{"value":true,"url":"http://127.0.0.1/"}'),
        browser_run_code_unsafe: () => textResult('typed'),
      },
    );
    const locator = new ShimLocator(client, '#phone');

    await locator.pressSequentially('123', { delay: 20 });
    expect(client.calls.at(-1)?.name).toBe('browser_run_code_unsafe');
    expect(String(client.calls.at(-1)?.args.code)).toContain('.pressSequentially(');
    expect(String(client.calls.at(-1)?.args.code)).toContain('"delay":20');
    await locator.blur();
    expect(client.calls.at(-1)?.name).toBe('browser_evaluate');
    expect(String(client.calls.at(-1)?.args.function)).toContain('el.blur()');
  });
});
