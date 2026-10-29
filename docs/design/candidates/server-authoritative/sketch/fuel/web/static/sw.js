// @ts-check
/**
 * fuel service worker. Holds no domain state and does no domain math.
 *
 * It owns exactly two things:
 * 1. A read-only snapshot cache: the app shell (precached) and the last copy of each page.
 * 2. An outbox: POST /commands bodies that could not reach the mini, replayed in order later.
 *
 * Offline contract:
 * - Navigations: network first with a 2.5 s timeout, then the cached copy of that URL, then the
 *   cached "/" page. Pages carry <meta name="rendered-at">, which fuel.js shows in the banner.
 * - POST /commands: if the outbox is non-empty, flush it first so order is kept, then send.
 *   On network failure or timeout, store the body and answer 202 with
 *   `HX-Trigger: fuel:queued` and `HX-Reswap: none`. fuel.js then lists the item under
 *   "Waiting for the mini" using the server-rendered data-label of the form. No totals change
 *   offline; the stale totals say "as of 2:14 pm, 2 items not counted".
 * - Everything else (search, /snap, /barcode, /foods/import, /drafts) fails with an
 *   offline fragment. These need the mini by design.
 * - Flush runs on any successful network response, on a "flush" message from fuel.js
 *   (load, online, visibilitychange), and before every new command. iOS has no Background
 *   Sync, so the queue drains when the app is next opened while reachable.
 * - Replay sends `Accept: application/json`. 2xx (applied or duplicate) deletes the item.
 *   409 or 422 moves it to the rejected store, shown with the server's reason. Network
 *   errors and 5xx stop the flush and keep the item. Command ids make every replay safe.
 */

/** Injected by GET /sw.js from the hashed static directory. */
const SHELL_VERSION = "__SHELL_VERSION__";
/** @type {string[]} */
const SHELL_ASSETS = /** @type {any} */ ("__SHELL_ASSETS__");

/**
 * @typedef {object} QueuedCommand
 * @property {string} id            command id stamped by fuel.js at tap time (IndexedDB key)
 * @property {string} body          request body exactly as sent
 * @property {string} contentType   form-urlencoded or application/json
 * @property {string} label         display text the server rendered on the form
 * @property {string} queuedAt      ISO instant
 */

/** @param {ExtendableEvent} event */
function onInstall(event) {
  throw new Error("not implemented: precache SHELL_ASSETS and '/' under SHELL_VERSION");
}

/** @param {ExtendableEvent} event */
function onActivate(event) {
  throw new Error("not implemented: delete caches whose name is not SHELL_VERSION");
}

/** @param {FetchEvent} event */
function onFetch(event) {
  throw new Error("not implemented: route navigations, static assets, POST /commands");
}

/**
 * Send a command, flushing older queued ones first. Serialized through one promise chain so
 * two taps can never reorder.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function sendOrQueue(request) {
  throw new Error("not implemented");
}

/**
 * Replay queued commands oldest first until one fails on the network.
 * @returns {Promise<{applied: number, rejected: number, remaining: number}>}
 */
async function flush() {
  throw new Error("not implemented");
}

/**
 * @param {QueuedCommand} item
 * @returns {Promise<void>}
 */
async function enqueue(item) {
  throw new Error("not implemented: IndexedDB store 'outbox', keyPath 'id'");
}
