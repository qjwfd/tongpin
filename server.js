'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const urlPath = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

const DEBUG = process.env.DEBUG_GAME === '1';

function log(...args) {
  if (DEBUG) console.log('[game]', ...args);
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12);
}

function cleanWord(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normWord(word) {
  return (word || '')
    .replace(/[\s，。！？、,.!?~～…·'"“”‘’\-—_（）()【】[\]]/g, '')
    .toLowerCase();
}

function createRoom() {
  return {
    code: newCode(),
    players: [null, null],
    round: 1,
    phase: 'waiting', // waiting | input | reveal | over
    history: [],
    current: [null, null],
    winnerRound: null,
    updatedAt: Date.now(),
  };
}

function makePlayer(name, ws) {
  return {
    name,
    token: newToken(),
    socket: ws,
    connected: true,
    submitted: false,
    word: null,
    ready: false,
  };
}

function resetPlayers(room) {
  room.players.forEach((p) => {
    if (!p) return;
    p.submitted = false;
    p.word = null;
    p.ready = false;
  });
}

function playerView(room, slot) {
  const me = room.players[slot];
  const opp = room.players[1 - slot];
  const revealed = room.phase === 'over';

  return {
    code: room.code,
    round: room.round,
    phase: room.phase,
    history: room.history,
    winnerRound: room.winnerRound,
    you: {
      slot,
      name: me ? me.name : '',
      word: me ? room.current[slot] : null,
      submitted: !!(me && me.submitted),
      ready: !!(me && me.ready),
    },
    opponent: opp
      ? {
          slot: 1 - slot,
          name: opp.name,
          connected: opp.connected,
          submitted: opp.submitted,
          ready: opp.ready,
          word: revealed ? room.current[1 - slot] : null,
        }
      : null,
    current: revealed ? { words: room.current.slice(), same: true } : null,
  };
}

function broadcast(room) {
  room.updatedAt = Date.now();
  log('broadcast', room.code, room.phase, 'r' + room.round, room.players.map((p) => (p ? (p.name + (p.submitted ? '+' : '') + (p.ready ? '*' : '')) : '-')).join(' vs '));
  room.players.forEach((p, slot) => {
    if (p && p.socket) send(p.socket, { type: 'state', state: playerView(room, slot) });
  });
}

function roomOf(ws) {
  const meta = ws.meta;
  if (!meta) return null;
  const room = rooms.get(meta.code);
  if (!room) return null;
  return { room, slot: meta.slot };
}

function doCreate(ws, msg) {
  if (ws.meta) doLeave(ws);

  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', message: '先给自己起个昵称吧' });

  const room = createRoom();
  const player = makePlayer(name, ws);
  room.players[0] = player;
  rooms.set(room.code, room);

  ws.meta = { code: room.code, slot: 0 };
  send(ws, { type: 'joined', code: room.code, token: player.token, slot: 0 });
  broadcast(room);
}

function doJoin(ws, msg) {
  if (ws.meta) doLeave(ws);

  const name = cleanName(msg.name);
  const code = String(msg.code || '').trim().toUpperCase();
  if (!name) return send(ws, { type: 'error', message: '先给自己起个昵称吧' });
  if (code.length !== 4) return send(ws, { type: 'error', message: '房间码是 4 位哦' });

  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'error', message: '没有找到这个房间' });
  if (room.players[1]) return send(ws, { type: 'error', message: '房间已经满了' });

  const player = makePlayer(name, ws);
  room.players[1] = player;
  if (room.phase === 'waiting') {
    room.phase = 'input';
    room.round = 1;
    room.history = [];
    room.current = [null, null];
    resetPlayers(room);
  }

  ws.meta = { code, slot: 1 };
  send(ws, { type: 'joined', code, token: player.token, slot: 1 });
  broadcast(room);
}

function doResume(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  const token = String(msg.token || '');
  const room = rooms.get(code);
  if (!room || !token) return send(ws, { type: 'resumeFailed' });

  const slot = room.players.findIndex((p) => p && p.token === token);
  if (slot === -1) return send(ws, { type: 'resumeFailed' });

  const player = room.players[slot];
  if (player.socket && player.socket !== ws) {
    const old = player.socket;
    player.socket = null;
    try {
      old.meta = null;
      old.close(4000, 'replaced');
    } catch (_) {
      /* noop */
    }
  }

  player.socket = ws;
  player.connected = true;
  ws.meta = { code, slot };
  send(ws, { type: 'joined', code, token: player.token, slot, resumed: true });
  broadcast(room);
}

function doSubmit(ws, msg) {
  const found = roomOf(ws);
  if (!found) return;
  const { room, slot } = found;
  const player = room.players[slot];

  if (!player || room.phase !== 'input' || player.submitted) return;
  if (!room.players[0] || !room.players[1]) return;

  const word = cleanWord(msg.word);
  if (!word) return send(ws, { type: 'error', message: '先写一个词吧' });
  if ([...word].length > 12) return send(ws, { type: 'error', message: '最多 12 个字哦' });

  player.word = word;
  player.submitted = true;
  room.current[slot] = word;

  const opp = room.players[1 - slot];
  if (opp && opp.submitted) {
    const a = room.current[0];
    const b = room.current[1];
    const same = normWord(a) !== '' && normWord(a) === normWord(b);

    room.history.push({ round: room.round, words: [a, b], same });

    if (same) {
      room.phase = 'over';
      room.winnerRound = room.round;
    } else {
      // 直接进入下一轮，不需要单独的揭晓确认步骤
      room.round += 1;
      room.phase = 'input';
      room.current = [null, null];
      resetPlayers(room);
    }
  }

  broadcast(room);
}

function doNext(ws) {
  // 保留兼容性，但不再有 reveal 阶段
  const found = roomOf(ws);
  if (!found) return;
  broadcast(found.room);
}

function doRematch(ws) {
  const found = roomOf(ws);
  if (!found) return;
  const { room, slot } = found;
  const player = room.players[slot];
  if (!player || room.phase !== 'over') return;

  player.ready = true;
  const bothReady = room.players.every((p) => p && p.ready);
  if (bothReady) {
    room.round = 1;
    room.phase = 'input';
    room.history = [];
    room.current = [null, null];
    room.winnerRound = null;
    resetPlayers(room);
  }
  broadcast(room);
}

function doLeave(ws) {
  const meta = ws.meta;
  ws.meta = null;
  if (!meta) return;

  const room = rooms.get(meta.code);
  if (!room) return;
  rooms.delete(room.code);

  room.players.forEach((p) => {
    if (!p) return;
    if (p.socket && p.socket !== ws) {
      p.socket.meta = null;
      send(p.socket, { type: 'roomClosed', message: '对方离开了房间' });
    }
    p.socket = null;
    p.connected = false;
  });

  send(ws, { type: 'left' });
}

function onClose(ws) {
  const found = roomOf(ws);
  if (!found) return;
  const { room, slot } = found;
  const player = room.players[slot];
  if (!player || player.socket !== ws) return;

  player.connected = false;
  player.socket = null;
  broadcast(room);
}

function route(ws, msg) {
  switch (msg.type) {
    case 'create':
      return doCreate(ws, msg);
    case 'join':
      return doJoin(ws, msg);
    case 'resume':
      return doResume(ws, msg);
    case 'submit':
      return doSubmit(ws, msg);
    case 'next':
      return doNext(ws);
    case 'rematch':
      return doRematch(ws);
    case 'leave':
      return doLeave(ws);
    case 'ping':
      return send(ws, { type: 'pong' });
    default:
      return undefined;
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (buf) => {
    if (buf.length > 4096) return;
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    log('msg', msg.type, ws.meta ? ws.meta.code : '-', ws.meta ? ws.meta.slot : '-', msg.word || '');
    try {
      route(ws, msg);
    } catch (err) {
      console.error('[message]', err);
    }
  });

  ws.on('close', (code) => {
    log('close', code, ws.meta ? ws.meta.code : '-', ws.meta ? ws.meta.slot : '-');
    onClose(ws);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPings = (ws.missedPings || 0) + 1;
      if (ws.missedPings >= 2) {
        ws.terminate();
        return;
      }
    } else {
      ws.missedPings = 0;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyOnline = room.players.some((p) => p && p.connected);
    if (!anyOnline && now - room.updatedAt > 30 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`同频 running at http://localhost:${PORT}`);
});
