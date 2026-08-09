export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve `work`, or null if it takes longer than `ms`. The export drives the
 * page through CDP, and those calls can stop answering when it wedges — a
 * dropped frame is recoverable, a hung await takes the Stop button with it.
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
