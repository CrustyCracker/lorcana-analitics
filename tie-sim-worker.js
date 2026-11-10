/* Web Worker: Monte Carlo tie simulation off the main thread */
/* global LorcanaTieSim */
importScripts('tie-sim-core.js');

self.onmessage = function (event) {
    const msg = event.data || {};
    const requestId = msg.requestId;
    try {
        if (!msg.input || typeof LorcanaTieSim === 'undefined') {
            self.postMessage({ requestId, error: 'Brak kontekstu symulacji.' });
            return;
        }
        const result = LorcanaTieSim.executePreparedTieSimulation(msg.input);
        self.postMessage({ requestId, result });
    } catch (err) {
        self.postMessage({
            requestId,
            error: (err && err.message) ? err.message : String(err)
        });
    }
};
