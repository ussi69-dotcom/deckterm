// A startup step that waits on an external process (tmux) must not keep the
// service from opening its port forever: a stopped or wedged tmux server whose
// socket still exists never answers, and every restart would hang the same way.

export type DeadlineResult<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: true }
  | { ok: false; timedOut: false; error: unknown };

/** Runs `step` until it settles or `ms` pass. A step that times out keeps
 * running in the background; the caller decides what to skip after it. */
export async function runWithDeadline<T>(
  step: () => Promise<T>,
  ms: number,
): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      step().then(
        (value): DeadlineResult<T> => ({ ok: true, value }),
        (error): DeadlineResult<T> => ({ ok: false, timedOut: false, error }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
