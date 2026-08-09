import { render } from 'preact';
import { ScriptEditorApp } from '@/components/script-editor/ScriptEditorApp';
import '@/components/ui/theme.css';
import '@/components/script-editor/script-editor.css';

render(<ScriptEditorApp />, document.getElementById('app')!);
