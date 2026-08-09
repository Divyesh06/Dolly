import { render } from 'preact';
import { ControllerApp } from '@/components/controller/ControllerApp';
import '@/components/ui/theme.css';
import '@/components/controller/controller.css';

render(<ControllerApp />, document.getElementById('app')!);
