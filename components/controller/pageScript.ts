export type ScriptOutcome = {
  ok: boolean;
  error?: string;
};

/**
 * Run a JS keyframe's source in the recorded page's main world, so it sees the
 * page's own globals. Injection is extension-privileged, so it works on pages
 * that would refuse an appended `<script>`.
 *
 * Snippets are synchronous, so a keyframe's effect lands on exactly the frame
 * it sits on. Waiting for deferred work would deadlock: the page's clock is
 * stepped by the capture loop, and the step that would release it is what this
 * call is holding up. Work that belongs later belongs on its own keyframe.
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
          // this wrapper's, and unwrapped so whatever it throws is reported.
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
