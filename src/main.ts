import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles/main.css';
import { App } from './app';

const root = document.getElementById('app')!;
const app = new App(root);
// handy for poking at the simulation from the console
(window as unknown as { litho: App }).litho = app;
