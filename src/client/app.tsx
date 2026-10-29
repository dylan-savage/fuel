import { useState } from 'preact/hooks';
import { useRegisterSW } from 'virtual:pwa-register/preact';
import { Scan } from './screens/Scan.js';
import { Today } from './screens/Today.js';
import { Waiting } from './screens/Waiting.js';

type Tab = 'today' | 'scan';

export function App() {
  const [tab, setTab] = useState<Tab>('today');
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  return (
    <div class="app">
      <header>
        <h1>fuel</h1>
        <Waiting />
      </header>
      {needRefresh && (
        <button class="banner" onClick={() => void updateServiceWorker(true)}>
          A new version is ready. Tap to reload.
        </button>
      )}
      <main>{tab === 'today' ? <Today /> : <Scan />}</main>
      <nav>
        <button aria-pressed={tab === 'today'} onClick={() => setTab('today')}>
          Today
        </button>
        <button aria-pressed={tab === 'scan'} onClick={() => setTab('scan')}>
          Scan
        </button>
      </nav>
    </div>
  );
}
