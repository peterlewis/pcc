// decimate-worker.js — off-main-thread decimation for the FUTURE scrub view.
//
// The live charts never use this: their RAM buffers are small and decimate() is
// a no-op at that size. But when the scrub view pulls a multi-hour / multi-day
// window out of IndexedDB (hundreds of thousands of points), decimating it
// inline could stall paint on the seek. This worker moves that one heavy pass
// off the main thread. Shipped now so the scrub view is unblocked; not wired
// into any current render path.
//
// Module worker: new Worker(new URL('./decimate-worker.js', import.meta.url), { type: 'module' }).
// Protocol: postMessage({ id, points, target, mode, xKey, yKey }) ->
//           postMessage({ id, points }).  Points are plain {x, y} pairs here
//           (the caller maps store rows to pairs before posting).

import { decimate } from './decimate.js?v=1';

self.onmessage = (e) => {
  const { id, points, target, mode } = e.data || {};
  try {
    const out = decimate(points || [], target | 0, { mode: mode || 'lttb', x: (p) => p.x, y: (p) => p.y });
    self.postMessage({ id, points: out });
  } catch (err) {
    self.postMessage({ id, error: String(err), points: points || [] });
  }
};
