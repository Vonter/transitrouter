import './i18n';
import { h, render } from 'preact';
import BusDiagram from './diagram/index.js';

render(<BusDiagram />, document.getElementById('diagram'));
