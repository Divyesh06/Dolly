export type ScriptOutcome = {
  ok: boolean;
  error?: string;
};

/**
 * Run a JS keyframe's source in the recorded page's main world, so it sees the
 * page's own globals. Injection is extension-privileged, so it works on pages
 * that would refuse an appended `<script>`.
 *
 * Snippets are synchronous. They run to completion here and the shot moves on,
 * so a keyframe's effect lands on exactly the frame it sits on. Deferred work
 * has no place in that: during an export the page's clock is stepped by the
 * capture loop, so anything a snippet waited on would come due on some later
 * frame — and waiting for it here would deadlock outright, since the step that
 * would release it is what this call is holding up. A change that belongs
 * later belongs on its own keyframe at that time.
 */
export async function executeInPage(
  targetTabId: number,
  code: string,
): Promise<ScriptOutcome> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: targetTabId },
      world: 'MAIN',
      // Serialised and re-parsed in the page, so it closes over nothing —
      // everything it needs arrives through `args`.
      func: (snippet: string): ScriptOutcome => {
        try {
          // Indirect eval, so the snippet lands in global scope rather than
          // this wrapper's. Unwrapped, so whatever it throws — including the
          // syntax error a top-level `await` now raises — is caught here and
          // reported, rather than being lost to a detached promise.
          (0, eval)(snippet);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String((err as Error)?.stack ?? err) };
        }
      },
      args: [code],
    });
    return (
      (results?.[0]?.result as ScriptOutcome | undefined) ?? {
        ok: false,
        error: 'the page returned nothing',
      }
    );
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
