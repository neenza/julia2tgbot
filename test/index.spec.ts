import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// The env interface should be properly mocked for testing
describe('Jules Bot worker', () => {
	it('fails gracefully when env is missing', async () => {
		const request = new Request('http://example.com', { method: 'POST', body: '{}' });
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();

		const mockEnv = {} as any;

		const response = await worker.fetch(request, mockEnv, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"TELEGRAM_BOT_TOKEN is not set"`);
	});

	it('fails gracefully when JULES_API_KEY is missing', async () => {
		const request = new Request('http://example.com', { method: 'POST', body: '{}' });
		const ctx = createExecutionContext();
		const mockEnv = { TELEGRAM_BOT_TOKEN: 'mock_token' } as any;

		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"JULES_API_KEY is not set"`);
	});
});
