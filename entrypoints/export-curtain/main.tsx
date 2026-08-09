import { render } from 'preact';
import { ExportCurtainApp } from '@/components/export-curtain/ExportCurtainApp';
import '@/components/ui/theme.css';
import '@/components/export-curtain/export-curtain.css';

render(<ExportCurtainApp />, document.getElementById('app')!);
