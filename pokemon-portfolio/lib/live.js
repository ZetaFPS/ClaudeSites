'use strict';
// Live updates: each signed-in tab keeps one Server-Sent Events stream open (GET /api/events),
// and the server pushes small events to a user's streams — a new message, a friend request, the
// collection changed on another device, a ban. Events only say *what* changed; the app then
// fetches the details through the normal (permission-checked) API.
//
// Streams live in this process's memory. With several server instances an event only reaches the
// tabs connected to the instance that sent it; the app's slower background polling covers the rest.

const HEARTBEAT_MS = 25e3; // keeps proxies from closing idle streams
const MAX_STREAMS_PER_USER = 10;

function createLive() {
  const streams = new Map(); // userId -> Set<res>

  function attach(req, res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't buffer behind nginx-style proxies
    });
    res.write('retry: 4000\n\n');
    let set = streams.get(user.id);
    if (!set) streams.set(user.id, (set = new Set()));
    if (set.size >= MAX_STREAMS_PER_USER) { const oldest = set.values().next().value; set.delete(oldest); oldest.end(); }
    set.add(res);
    write(res, 'hello', { at: Date.now() });
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const done = () => {
      clearInterval(beat);
      set.delete(res);
      if (!set.size && streams.get(user.id) === set) streams.delete(user.id);
    };
    req.on('close', done);
    res.on('error', done);
  }

  function write(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`); } catch { /* closed */ }
  }

  function send(userId, event, data) {
    for (const res of streams.get(userId) || []) write(res, event, data);
  }
  function sendMany(userIds, event, data) {
    for (const id of new Set(userIds)) send(id, event, data);
  }
  // Close a user's streams (signed out, banned or deleted) after telling them why.
  function kick(userId, event, data) {
    for (const res of streams.get(userId) || []) { write(res, event, data); res.end(); }
    streams.delete(userId);
  }
  const online = () => streams.size;

  return { attach, send, sendMany, kick, online };
}

module.exports = { createLive };
