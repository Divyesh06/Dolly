import { useEffect, useRef, useState } from 'preact/hooks';
import {
  javascript,
  javascriptLanguage,
  scopeCompletionSource,
} from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
import { basicSetup, EditorView } from 'codemirror';
import { SCRIPT_CHANNEL, type ScriptResponse } from '@/lib/protocol';

/** Debounce on writing edits back to the controller. */
const AUTOSAVE_MS = 400;

type Status = 'loading' | 'ready' | 'lost';

/**
 * The editor window for one JS keyframe. The controller owns the keyframe list,
 * so this loads by id on mount and posts edits back.
 */
export function ScriptEditorApp() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('loading');

  const keyframeId = new URLSearchParams(window.location.search).get('id');

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !keyframeId) {
      setStatus('lost');
      return;
    }

    let view: EditorView | null = null;
    let disposed = false;
    let timer = 0;

    const push = () => {
      if (!view) return;
      // Fire-and-forget: nothing is listening if the controller has closed.
      void browser.runtime
        .sendMessage({
          channel: SCRIPT_CHANNEL,
          op: 'save',
          id: keyframeId,
          code: view.state.doc.toString(),
        })
        .catch(() => {});
    };
    const onPageHide = () => {
      window.clearTimeout(timer);
      push();
    };

    (async () => {
      const res = (await browser.runtime.sendMessage({
        channel: SCRIPT_CHANNEL,
        op: 'load',
        id: keyframeId,
      })) as ScriptResponse | undefined;

      if (disposed) return;
      if (!res?.ok || res.code == null) {
        setStatus('lost');
        return;
      }

      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: res.code,
          extensions: [
            basicSetup,
            javascript(),
            // Completion introspected off the real `globalThis`. Registered as
            // language data so it sits alongside the JS package's own.
            javascriptLanguage.data.of({
              autocomplete: scopeCompletionSource(globalThis),
            }),
            oneDark,
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  window.clearTimeout(timer);
                  push();
                  // Returning true also stops the browser's own save dialog.
                  return true;
                },
              },
            ]),
            // Autosave, so closing the window can't lose work.
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              window.clearTimeout(timer);
              timer = window.setTimeout(push, AUTOSAVE_MS);
            }),
            EditorView.theme({
              '&': { height: '100%', fontSize: '13px' },
              '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
            }),
          ],
        }),
      });
      setStatus('ready');
      // A pending debounce would otherwise die with the window.
      window.addEventListener('pagehide', onPageHide);
    })();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', onPageHide);
      view?.destroy();
      view = null;
    };
  }, [keyframeId]);

  return (
    <div class="dolly-script">
      {status === 'lost' ? (
        <div class="dolly-script__empty">
          This keyframe is no longer available. It may have been deleted, or the
          Dolly controller closed.
        </div>
      ) : (
        <div ref={hostRef} class="dolly-script__editor" />
      )}
    </div>
  );
}
