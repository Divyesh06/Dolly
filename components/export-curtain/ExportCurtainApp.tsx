import { useEffect, useState } from 'preact/hooks';
import {
  EXPORT_CHANNEL,
  isExportNotice,
  type ExportNotice,
  type ExportOutcome,
} from '@/lib/protocol';

type State =
  | { phase: 'working'; done: number; total: number }
  | { phase: 'finished'; outcome: ExportOutcome; summary: string };

const HEADLINES: Record<ExportOutcome, string> = {
  done: 'Export finished',
  cancelled: 'Export stopped',
  failed: 'Export failed',
};

/** Covers the page while an export runs: hides flicker, blocks stray clicks. */
export function ExportCurtainApp() {
  const [state, setState] = useState<State>({
    phase: 'working',
    done: 0,
    total: 0,
  });

  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if (!isExportNotice(msg)) return;
      const notice = msg as ExportNotice;
      if (notice.op === 'progress') {
        setState({
          phase: 'working',
          done: notice.done,
          total: notice.total,
        });
      } else if (notice.op === 'finished') {
        setState({
          phase: 'finished',
          outcome: notice.outcome,
          summary: notice.summary,
        });
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  const cancel = () => {
    // Fire-and-forget: nothing is listening if the controller has closed.
    void browser.runtime
      .sendMessage({
        channel: EXPORT_CHANNEL,
        op: 'cancel',
      })
      .catch(() => {});
  };

  if (state.phase === 'finished') {
    return (
      <div class="dolly-curtain">
        <div class="dolly-curtain__panel">
          <div
            class={`dolly-curtain__headline ${
              state.outcome === 'failed'
                ? 'dolly-curtain__headline--failed'
                : ''
            }`}
          >
            {HEADLINES[state.outcome]}
          </div>
          <pre
            class={`dolly-curtain__summary ${
              state.outcome === 'failed' ? 'dolly-curtain__summary--failed' : ''
            }`}
          >
            {state.summary}
          </pre>
          <button class="dolly-curtain__button" onClick={() => window.close()}>
            Done
          </button>
        </div>
      </div>
    );
  }

  const percent =
    state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;

  return (
    <div class="dolly-curtain">
      <div class="dolly-curtain__panel">
        <div class="dolly-curtain__percent">{percent}%</div>
        <div class="dolly-curtain__track">
          <div
            class="dolly-curtain__fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div class="dolly-curtain__detail">
          {state.total > 0
            ? `Frame ${state.done} of ${state.total}`
            : 'Preparing…'}
        </div>
        <button class="dolly-curtain__button" onClick={cancel}>
          Stop export
        </button>
      </div>
      <div class="dolly-curtain__note">
        The tab gets flashy while recording. Best not to look at it&nbsp;:)
      </div>
    </div>
  );
}
