import { render } from 'preact';
import { EditorApp } from '@/components/editor/EditorApp';
import '@/components/editor/editor.css';

render(<EditorApp />, document.getElementById('app')!);
