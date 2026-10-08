/**
 * Web Serial teardown, extracted so the ordering contract can be unit-tested.
 *
 * ## Why this exists
 *
 * `port.readable.pipeTo(...)` keeps the port's readable stream **locked** while
 * the pipe is alive. If the pipe promise is dropped and `port.close()` is called
 * straight after `reader.cancel()`, close() rejects with "The port is locked",
 * the port stays open, and the next connect fails with:
 *
 *     Failed to execute 'open' on 'SerialPort': The port is already open.
 *
 * So the order is: cancel the reader → **await the pipe** (which releases the
 * lock) → close the port. A failed close is reported, never swallowed, because
 * swallowing it made the UI log "Serial port closed." while the port was open.
 */

/** Minimal structural shapes, so fakes can be used in tests (no DOM needed). */
export interface SerialReaderLike {
  cancel(): Promise<void>;
}

export interface SerialPortLike {
  close(): Promise<void>;
}

export interface SerialHandles {
  reader?: SerialReaderLike | null;
  pipe?: Promise<unknown> | null;
  port?: SerialPortLike | null;
}

export interface ReleaseOutcome {
  /** True when the port was closed (or there was nothing to close). */
  closed: boolean;
  /** Human-readable reason when closing failed. */
  error: string | null;
}

/**
 * How long to wait for the pipe to release the port's lock.
 *
 * Bounded on purpose: if `reader.cancel()` itself threw (device unplugged
 * mid-read) the pipe can stay pending forever, and awaiting it unbounded would
 * hang the Disconnect button. Waiting a moment and then closing anyway is both
 * safe and always finishes.
 */
export const PIPE_SETTLE_TIMEOUT_MS = 400;

/** Resolves when `promise` settles or `ms` elapses, whichever comes first. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Releases a serial session in the only order that actually works.
 *
 * Never throws and never hangs: a reader that is already dead, a pipe that
 * rejects (device unplugged), or a pipe that never settles are all normal on a
 * serial link, and each outcome is reported through {@link ReleaseOutcome}.
 */
export async function releaseSerialSession(handles: SerialHandles): Promise<ReleaseOutcome> {
  const { reader, pipe, port } = handles;

  if (reader) {
    try {
      await reader.cancel();
    } catch {
      /* already cancelled, or the device vanished */
    }
  }

  if (pipe) await settleWithin(pipe, PIPE_SETTLE_TIMEOUT_MS);

  if (!port) return { closed: true, error: null };

  try {
    await port.close();
    return { closed: true, error: null };
  } catch (firstError) {
    // Give the pipe one more moment: cancelling the reader releases the lock
    // asynchronously, so a close issued immediately after can still see it held.
    if (pipe) {
      await settleWithin(pipe, PIPE_SETTLE_TIMEOUT_MS);
      try {
        await port.close();
        return { closed: true, error: null };
      } catch (secondError) {
        const message = secondError instanceof Error ? secondError.message : String(secondError);
        return { closed: false, error: message };
      }
    }
    const message = firstError instanceof Error ? firstError.message : String(firstError);
    return { closed: false, error: message };
  }
}
