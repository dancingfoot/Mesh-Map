import {createRoot} from 'react-dom/client';
// Leaflet's own stylesheet, bundled rather than fetched from unpkg: this app is
// used off-grid, and a CDN hiccup must not cost us the map controls or popups.
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
