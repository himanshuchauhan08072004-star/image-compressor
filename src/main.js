import '@fontsource/archivo/latin-500.css';
import '@fontsource/archivo/latin-600.css';
import '@fontsource/archivo/latin-700.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles.css';
import { startApp } from './app/app.js';

startApp({
  view: document.getElementById('view'),
  nav: document.getElementById('toolNav'),
  navStrip: document.getElementById('navStrip'),
  header: document.getElementById('siteHeader'),
  footer: document.getElementById('siteFooter'),
});
