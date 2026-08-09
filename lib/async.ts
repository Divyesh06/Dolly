export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve `work`, or null if it takes longer than `ms`.
 *
 * The export drives the recorded page through CDP, and several of those calls
 * can stop answering when the page is wedged. Nothing in that loop may block
 * for ever: a dropped frame is recoverable and says what went wrong, whereas a
 * hung await takes the Stop button with it.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T | null> {
  let timer = 0;
  const expiry = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => {
      console.warn(`[Dolly] ${label} did not answer within ${ms}ms`);
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    window.clearTimeout(timer);
  }
}
