import { describe, expect, it, vi } from 'vitest';
import { releaseSerialSession } from './serialSession';

/** Builds the three handles, recording the order in which they are touched. */
function handles(opts: { closeRejects?: string; pipeRejects?: boolean; readerRejects?: boolean } = {}) {
  const order: string[] = [];

  let resolvePipe!: () => void;
  const pipe = new Promise<void>((resolve, reject) => {
    resolvePipe = () => {
      order.push('pipe-settled');
      opts.pipeRejects ? reject(new Error('stream ended')) : resolve();
    };
  });

  const reader = {
    cancel: vi.fn(async () => {
      order.push('reader.cancel');
      if (opts.readerRejects) throw new Error('already cancelled');
      // The pipe settles as a consequence of cancelling the reader.
      queueMicrotask(resolvePipe);
    }),
  };

  const port = {
    close: vi.fn(async () => {
      order.push('port.close');
      if (opts.closeRejects) throw new Error(opts.closeRejects);
    }),
  };

  return { order, reader, port, pipe };
}

describe('releaseSerialSession', () => {
  it('cancels the reader, awaits the pipe, then closes the port', async () => {
    const h = handles();
    const outcome = await releaseSerialSession(h);

    expect(outcome).toEqual({ closed: true, error: null });
    // The order is the whole point: closing before the pipe settles fails.
    expect(h.order).toEqual(['reader.cancel', 'pipe-settled', 'port.close']);
    expect(h.port.close).toHaveBeenCalledTimes(1);
  });

  it('awaits the pipe before closing even when close would otherwise reject', async () => {
    // A port that refuses to close while its readable is still locked.
    let locked = true;
    const order: string[] = [];
    let resolvePipe!: () => void;
    const pipe = new Promise<void>((resolve) => {
      resolvePipe = () => {
        locked = false;
        order.push('unlocked');
        resolve();
      };
    });
    const reader = { cancel: vi.fn(async () => queueMicrotask(resolvePipe)) };
    const port = {
      close: vi.fn(async () => {
        order.push('close');
        if (locked) throw new Error('The port is locked.');
      }),
    };

    const outcome = await releaseSerialSession({ reader, port, pipe });
    expect(outcome.closed).toBe(true);
    expect(order).toEqual(['unlocked', 'close']);
    expect(locked).toBe(false);
  });

  it('reports a close failure instead of swallowing it', async () => {
    const h = handles({ closeRejects: 'The port is locked.' });
    const outcome = await releaseSerialSession(h);

    expect(outcome.closed).toBe(false);
    expect(outcome.error).toMatch(/locked/);
  });

  it('tolerates a reader that is already cancelled and a rejected pipe', async () => {
    const h = handles({ readerRejects: true, pipeRejects: true });
    const outcome = await releaseSerialSession(h);

    expect(outcome.closed).toBe(true);
    expect(h.port.close).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression: awaiting the pipe unbounded hang the Disconnect button when
   * `reader.cancel()` threw and the pipe therefore never settled.
   */
  it('never hangs when the pipe never settles', async () => {
    const port = { close: vi.fn(async () => undefined) };
    const reader = { cancel: vi.fn(async () => { throw new Error('unplugged'); }) };
    const never = new Promise<void>(() => {});

    const started = Date.now();
    const outcome = await releaseSerialSession({ reader, pipe: never, port });
    const elapsed = Date.now() - started;

    expect(outcome.closed).toBe(true);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(2000);
  });

  it('retries a close that failed while the lock was still held', async () => {
    let locked = true;
    let resolvePipe!: () => void;
    const pipe = new Promise<void>((resolve) => {
      resolvePipe = () => { locked = false; resolve(); };
    });
    // Unlock LATER than PIPE_SETTLE_TIMEOUT_MS, so the first close really does
    // hit a locked port and the retry path is exercised.
    const reader = { cancel: vi.fn(async () => { setTimeout(resolvePipe, 500); }) };
    const port = {
      close: vi.fn(async () => {
        if (locked) throw new Error('The port is locked.');
      }),
    };

    const outcome = await releaseSerialSession({ reader, port, pipe });
    expect(outcome.closed).toBe(true);
    // First attempt fails, the retry succeeds once the lock is released.
    expect(port.close).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when nothing is open', async () => {
    expect(await releaseSerialSession({})).toEqual({ closed: true, error: null });
    expect(await releaseSerialSession({ reader: null, pipe: null, port: null })).toEqual({
      closed: true,
      error: null,
    });
  });

  it('closes a port even when there is no reader or pipe recorded', async () => {
    const port = { close: vi.fn(async () => undefined) };
    const outcome = await releaseSerialSession({ port });
    expect(outcome.closed).toBe(true);
    expect(port.close).toHaveBeenCalledTimes(1);
  });
});
