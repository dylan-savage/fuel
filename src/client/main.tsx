import { render } from 'preact';
import { App } from './app.js';
import { now } from './clock.js';
import { createIntents } from './intents.js';
import { openReplica } from './replica.js';
import { startSync } from './sync.js';
import { FuelContext, type Fuel } from './views.js';
import './styles.css';

const { replica, port } = await openReplica();
const sync = startSync(port, replica);
// Asks WebKit not to evict IndexedDB; the outbox can hold the only copy of a write.
void navigator.storage?.persist?.();

const fuel: Fuel = {
  replica,
  intents: createIntents(replica, { now, newId: () => crypto.randomUUID() }),
  sync: sync.state,
};
const root = document.getElementById('app');
if (root === null) throw new Error('#app is missing from index.html');
render(
  <FuelContext.Provider value={fuel}>
    <App />
  </FuelContext.Provider>,
  root,
);
