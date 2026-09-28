import { describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../src/utils/rateLimit.js';

describe('RateLimiter', () => {
  it('does not wait on first acquire', async () => {
    const sleep = vi.fn(async () => {});
    const rl = new RateLimiter({ delayMs: 100, now: () => 1000, sleep });
    await rl.acquire('https://a.com');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits when calls to the same origin come too fast', async () => {
    const sleep = vi.fn(async () => {});
    const now = vi.fn(() => 1000);
    const rl = new RateLimiter({ delayMs: 500, now, sleep });
    await rl.acquire('https://a.com');
    now.mockReturnValue(1100); // 100ms later
    await rl.acquire('https://a.com');
    expect(sleep).toHaveBeenCalledWith(400);
  });

  it('does not wait for different origins', async () => {
    const sleep = vi.fn(async () => {});
    const now = vi.fn(() => 1000);
    const rl = new RateLimiter({ delayMs: 500, now, sleep });
    await rl.acquire('https://a.com');
    now.mockReturnValue(1001);
    await rl.acquire('https://b.com');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is a no-op with delayMs 0', async () => {
    const sleep = vi.fn(async () => {});
    const rl = new RateLimiter({ delayMs: 0, now: () => 1000, sleep });
    await rl.acquire('https://a.com');
    await rl.acquire('https://a.com');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('tracks pending wait correctly', () => {
    let t = 1000;
    const rl = new RateLimiter({ delayMs: 200, now: () => t, sleep: async () => {} });
    void rl.acquire('https://a.com');
    // Right after a hit the full delay is still pending.
    expect(rl.pendingWait('https://a.com')).toBe(200);
    t = 1050;
    expect(rl.pendingWait('https://a.com')).toBe(150);
  });
});
