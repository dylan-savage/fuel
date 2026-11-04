/* global window, IDBIndex, IDBObjectStore */
// Loaded into the page by a timing spec, to count what IndexedDB really served.
window.idbReads = [];
for (const [where, proto] of [
  ['index', IDBIndex.prototype],
  ['store', IDBObjectStore.prototype],
]) {
  for (const method of ['get', 'getAll', 'openCursor']) {
    const original = proto[method];
    proto[method] = function (...args) {
      const at = performance.now();
      const request = original.apply(this, args);
      const read = { name: `${where}.${method}`, at, done: at, rows: 0 };
      window.idbReads.push(read);
      request.addEventListener('success', () => {
        read.done = performance.now();
        const { result } = request;
        read.rows += Array.isArray(result) ? result.length : result === null || result === undefined ? 0 : 1;
      });
      return request;
    };
  }
}
