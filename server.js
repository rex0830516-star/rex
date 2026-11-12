'use strict';
// 紅黑大小單雙 · 多人連線伺服器(零依賴,Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000, TURN_MS = 30000;
const isRed = d => d == 1 || d == 4;
const CATS = {
  red: { n: '紅', f: isRed }, black: { n: '黑', f: d => !isRed(d) },
  odd: { n: '單', f: d => d % 2 == 1 }, even: { n: '雙', f: d => d % 2 == 0 },
  big: { n: '大', f: d => d >= 4 }, small: { n: '小', f: d => d <= 3 }
};
const KEYS = Object.keys(CATS), FACE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const rooms = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hand = () => Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 6)).sort();
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 8) || '玩家';

function newRoom(max) {
  let code;
  do code = String(100000 + Math.floor(Math.random() * 900000)); while (rooms.has(code));
  const r = { code, max, phase: 'lobby', host: null, players: [], turn: -1, reveal: -1, msg: '', logs: [], lost: [], deadline: 0, timer: null, busy: false, last: Date.now() };
  rooms.set(code, r);
  return r;
}
const log = (r, t) => { r.logs.push(t); r.logs = r.logs.slice(-6); r.msg = t; };

// 每位玩家只收到自己有權看到的骰子
function view(r, pid) {
  return {
    code: r.code, max: r.max, phase: r.phase, host: r.host, me: pid, turn: r.turn,
    msg: r.msg, logs: r.logs, lost: r.lost, deadline: r.deadline, now: Date.now(),
    players: r.players.map((p, i) => ({
      id: p.id, name: p.name, n: p.dice.length, online: !!p.res,
      dice: (r.reveal === i || (p.id === pid && p.dice.length > 1)) ? p.dice : null
    }))
  };
}
function push(r) {
  for (const p of r.players) if (p.res) p.res.write('data: ' + JSON.stringify(view(r, p.id)) + '\n\n');
}

function startTurn(r) {
  clearTimeout(r.timer);
  r.deadline = Date.now() + TURN_MS;
  r.timer = setTimeout(() => autoCall(r), TURN_MS + 300);
}
function autoCall(r) {   // 超時代喊,避免卡關
  const p = r.players[r.turn];
  if (r.phase !== 'play' || !p || r.busy) return;
  let k = KEYS[Math.floor(Math.random() * 6)];
  if (p.dice.length > 1) {
    const safe = KEYS.filter(x => p.dice.some(d => !CATS[x].f(d)));
    k = safe.sort((a, b) => p.dice.filter(CATS[a].f).length - p.dice.filter(CATS[b].f).length)[0] || k;
  }
  call(r, k);
}

async function call(r, k) {
  if (r.busy || r.phase !== 'play') return;
  r.busy = true; clearTimeout(r.timer); r.deadline = 0;
  const p = r.players[r.turn], c = CATS[k], blind = p.dice.length === 1;
  log(r, `${p.name}喊:拿掉「${c.n}」`);
  if (blind) r.reveal = r.turn;
  push(r);
  await sleep(1300);
  const i = r.players.indexOf(p);
  if (r.phase !== 'play' || i < 0) { r.busy = false; if (r.phase === 'play') { r.turn %= r.players.length; startTurn(r); } push(r); return; }
  if (blind) log(r, `${p.name}亮出 ${FACE[p.dice[0]]}:${c.f(p.dice[0]) ? '和喊的相同,骰子被拿光' : '和喊的不同,過關'}`);
  const cut = [];
  for (const x of r.players) {
    const b = x.dice.length; x.dice = x.dice.filter(d => !c.f(d));
    if (b !== x.dice.length) cut.push(`${x.name} −${b - x.dice.length}`);
  }
  log(r, `拿掉「${c.n}」:${cut.length ? cut.join(',') + ' 顆' : '沒有人被拿掉骰子'}`);
  const lost = r.players.filter(x => !x.dice.length);
  if (lost.length) {
    r.phase = 'over'; r.lost = lost.map(x => x.name); r.turn = -1; r.reveal = -1;
    r.msg = `${r.lost.join('、')}的骰子被拿光,輸了!`;
  } else {
    r.turn = (i + 1) % r.players.length;
    r.reveal = r.players[r.turn].dice.length > 1 ? r.turn : -1;
    r.logs.push(`輪到${r.players[r.turn].name}`); r.logs = r.logs.slice(-6);
    startTurn(r);
  }
  r.busy = false; push(r);
}

function removePlayer(r, id) {
  const cur = r.players[r.turn], idx = r.players.findIndex(p => p.id === id);
  if (idx < 0) return;
  if (r.players[idx].res) try { r.players[idx].res.end(); } catch (e) { }
  r.players.splice(idx, 1);
  if (!r.players.length) { clearTimeout(r.timer); rooms.delete(r.code); return; }
  if (r.host === id) r.host = r.players[0].id;
  if (r.phase === 'play') {
    if (r.players.length < 2) { r.phase = 'over'; r.turn = -1; r.reveal = -1; r.lost = []; r.msg = '有玩家離開,遊戲結束'; clearTimeout(r.timer); }
    else if (cur && cur.id === id) { r.turn = idx % r.players.length; r.reveal = r.players[r.turn].dice.length > 1 ? r.turn : -1; if (!r.busy) startTurn(r); }
    else r.turn = r.players.indexOf(cur);
  }
  push(r);
}

function act(r, p, b) {
  r.last = Date.now();
  const isHost = r.host === p.id;
  if (b.t === 'start' && isHost && r.phase === 'lobby' && r.players.length > 1) {
    r.players.forEach(x => x.dice = hand());
    r.phase = 'play'; r.turn = 0; r.reveal = 0; r.lost = []; r.logs = []; log(r, `輪到${r.players[0].name}`);
    startTurn(r);
  } else if (b.t === 'again' && isHost && r.phase === 'over') {
    r.players.filter(x => !x.res).forEach(x => removePlayer(r, x.id));
    if (!rooms.has(r.code)) return;
    r.phase = 'lobby'; r.turn = -1; r.reveal = -1; r.msg = ''; r.logs = []; r.players.forEach(x => x.dice = []);
  } else if (b.t === 'call' && r.phase === 'play' && !r.busy && r.players[r.turn] === p && CATS[b.k]) {
    call(r, b.k); return;
  } else if (b.t === 'leave') { removePlayer(r, p.id); return; }
  push(r);
}

const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/') {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, b) => {
      if (e) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b);
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/events') {
    const r = rooms.get(u.searchParams.get('room')), pid = u.searchParams.get('pid');
    const p = r && r.players.find(x => x.id === pid);
    if (!p) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (p.res) try { p.res.end(); } catch (e) { }
    p.res = res; push(r);
    req.on('close', () => {
      if (p.res !== res) return;
      p.res = null; push(r);
      if (r.phase === 'lobby') setTimeout(() => { if (!p.res && r.phase === 'lobby' && rooms.has(r.code)) removePlayer(r, p.id); }, 15000);
    });
    return;
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2048) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw); } catch (e) { return json(res, 400, { error: '格式錯誤' }); }
      const pid = String(b.pid || '').slice(0, 40);
      if (!pid) return json(res, 400, { error: '缺少 pid' });
      if (u.pathname === '/api/create') {
        const r = newRoom(Math.min(4, Math.max(2, +b.max || 2)));
        r.players.push({ id: pid, name: clean(b.name), dice: [], res: null }); r.host = pid;
        return json(res, 200, { room: r.code });
      }
      const r = rooms.get(String(b.room || ''));
      if (!r) return json(res, 404, { error: '找不到房間,請確認代碼' });
      const p = r.players.find(x => x.id === pid);
      if (u.pathname === '/api/join') {
        if (!p) {
          if (r.phase !== 'lobby') return json(res, 409, { error: '遊戲已經開始了' });
          if (r.players.length >= r.max) return json(res, 409, { error: '房間已滿' });
          r.players.push({ id: pid, name: clean(b.name), dice: [], res: null });
          push(r);
        }
        return json(res, 200, { room: r.code });
      }
      if (u.pathname === '/api/act' && p) { act(r, p, b); return json(res, 200, { ok: true }); }
      json(res, 400, { error: '無效的操作' });
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('紅黑大小單雙 running on http://localhost:' + PORT));

setInterval(() => {   // 保持連線 + 清除閒置房間
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.last > 3 * 3600e3) { clearTimeout(r.timer); r.players.forEach(p => p.res && p.res.end()); rooms.delete(code); continue; }
    r.players.forEach(p => p.res && p.res.write(':\n\n'));
  }
}, 20000);
