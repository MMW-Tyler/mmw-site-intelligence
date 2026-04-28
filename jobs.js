/**
 * MMW Site Intelligence — Job Manager
 *
 * Manages the in-memory state of *active* crawls: connected SSE clients,
 * cancellation flag, replay buffer for late subscribers. The durable
 * record of each crawl (status, pages, summary) lives in Supabase via
 * crawl/store.js — this module only handles the live-progress side.
 *
 * Why not put this in Supabase too? Because SSE clients are connections,
 * not data, and replaying them through a database adds round-trip latency
 * for every progress event. In-memory is fine for live progress; if Render
 * restarts the process mid-crawl, the user will see the connection drop
 * and they can check the crawl's final status from the DB.
 *
 * Lifecycle:
 *   create(crawlId) → job
 *   job.emit(type, data)         — broadcasts to SSE clients + buffers for replay
 *   job.subscribe(res)           — attaches an SSE response stream
 *   job.cancel()                 — sets cancelled flag (engine checks via _cancelled())
 *   job.finish() / job.fail(err) — closes all SSE clients
 *   get(crawlId) → job | null
 */

'use strict';

const jobs = new Map();

function create(crawlId) {
  if (jobs.has(crawlId)) return jobs.get(crawlId);

  const job = {
    id:        crawlId,
    cancelled: false,
    finished:  false,
    events:    [],   // replay buffer: serialized SSE lines
    clients:   [],   // active res streams
  };

  job.emit = (type, data) => {
    const line = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    job.events.push(line);
    // Cap replay buffer at 500 events (mostly to keep memory bounded for big crawls)
    if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
    job.clients.forEach(c => { try { c.write(line); } catch (_) {} });
  };

  job.subscribe = (res) => {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx-style buffering on proxies
    });
    // Replay history
    job.events.forEach(e => res.write(e));
    if (job.finished) {
      res.end();
      return;
    }
    job.clients.push(res);
  };

  job.unsubscribe = (res) => {
    job.clients = job.clients.filter(c => c !== res);
  };

  job.cancel = () => {
    job.cancelled = true;
    job.emit('cancelled', { message: 'Crawl cancelled by user' });
  };

  job.finish = () => {
    job.finished = true;
    job.clients.forEach(c => { try { c.end(); } catch (_) {} });
    job.clients = [];
    // Schedule cleanup so completed jobs don't accumulate forever
    setTimeout(() => jobs.delete(crawlId), 10 * 60 * 1000); // 10 min retention
  };

  job.fail = (err) => {
    job.emit('error', { message: err.message || String(err) });
    job.finish();
  };

  job._cancelled = () => job.cancelled;

  jobs.set(crawlId, job);
  return job;
}

function get(crawlId) {
  return jobs.get(crawlId) || null;
}

module.exports = { create, get };
