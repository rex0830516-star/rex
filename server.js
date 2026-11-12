'use strict';
// 骰子遊戲伺服器(零依賴,Node 18+):紅黑大小單雙、吹牛
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
const hand = (n = 5) => Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6)).sort();
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 8) || '玩家';

function newRoom(max, mode) {
  let code;
  do code = String(100000 + Math.floor(Math.random() * 900000)); while (rooms.has(code));
  const r = {
    code, mode, max, phase: 'lobby', host: null, players: [], turn: -1, reveal: -1,
    showAll: false, bid: null, loser: null, loserName: '', winner: '', result: '',
    msg: '', logs: [], lost: [], deadline: 0, timer: null, busy: false, last: Date.now()
  };
  rooms.set(code, r);
  return r;
}
const log = (r, t) => { r.logs.push(t); r.logs = r.logs.slice(-6); r.msg = t; };

// 每位玩家只收到自己有權看到的骰子
function view(r, pid) {
  const liar = r.mode === 'liar';
  return {
    code: r.code, mode: r.mode, max: r.max, phase: r.phase, host: r.host, me: pid, turn: r.turn,
    msg: r.msg, logs: r.logs, lost: r.lost, lostIds: r.lostIds || [], deadline: r.deadline, now: Date.now(),
    bid: r.bid, showAll: r.showAll, loser: r.loser, loserName: r.loserName, winner: r.winner, result: r.result,
    players: r.players.map((p, i) => ({
      id: p.id, name: p.name, online: !!p.res,
      n: liar ? (p.cnt || 0) : p.dice.length,
      dice: liar
        ? (((p.id === pid || r.showAll) && p.dice.length) ? p.dice : null)
        : ((r.reveal === i || (p.id === pid && p.dice.length > 1)) ? p.dice : null)
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
const totalDice = r => r.players.reduce((s, p) => s + (p.cnt || 0), 0);
function aliveFrom(r, i) {
  const n = r.players.length;
  for (let k = 0; k < n; k++) { const j = (((i + k) % n) + n) % n; if (r.players[j].cnt > 0) return j; }
  return -1;
}

function autoCall(r) {   // 超時代喊,避免卡關
  const p = r.players[r.turn];
  if (r.phase !== 'play' || !p) return;
  if (r.mode === 'liar') {
    if (!r.bid) return liarBid(r, p, 1, 2 + Math.floor(Math.random() * 5));
    let q = r.bid.q, f = r.bid.f + 1;
    if (f > 6) { q++; f = 1; }
    if (q > totalDice(r)) return liarChallenge(r, p);
    return liarBid(r, p, q, f);
  }
  if (r.busy) return;
  let k = KEYS[Math.floor(Math.random() * 6)];
  if (p.dice.length > 1) {
    const safe = KEYS.filter(x => p.dice.some(d => !CATS[x].f(d)));
    k = safe.sort((a, b) => p.dice.filter(CATS[a].f).length - p.dice.filter(CATS[b].f).length)[0] || k;
  }
  call(r, k);
}

/* ---------- 紅黑大小單雙 ---------- */
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
    r.phase = 'over'; r.lost = lost.map(x => x.name); r.lostIds = lost.map(x => x.id); r.turn = -1; r.reveal = -1;
    r.msg = `${r.lost.join('、')}的骰子被拿光,輸了!`;
  } else {
    r.turn = (i + 1) % r.players.length;
    r.reveal = r.players[r.turn].dice.length > 1 ? r.turn : -1;
    r.logs.push(`輪到${r.players[r.turn].name}`); r.logs = r.logs.slice(-6);
    startTurn(r);
  }
  r.busy = false; push(r);
}

/* ---------- 吹牛 ---------- */
// 叫牌:數量更多,或數量相同、點數更大。1 點是百搭(叫 1 點時只算 1 點本身)。
function liarRound(r, si) {
  if (!rooms.has(r.code) || r.phase === 'over') return;
  r.players.forEach(x => x.dice = x.cnt > 0 ? hand(x.cnt) : []);
  r.bid = null; r.showAll = false; r.loser = null; r.loserName = ''; r.result = ''; r.phase = 'play';
  const i = aliveFrom(r, si < 0 ? 0 : si);
  r.turn = i;
  log(r, `新的一輪,${r.players[i].name}先叫牌`);
  startTurn(r); push(r);
}
function liarBid(r, p, q, f) {
  if (r.phase !== 'play') return;
  if (!Number.isInteger(q) || !Number.isInteger(f) || q < 1 || q > totalDice(r) || f < 1 || f > 6) return push(r);
  if (r.bid && !(q > r.bid.q || (q === r.bid.q && f > r.bid.f))) return push(r);
  r.bid = { q, f, by: p.id, name: p.name };
  log(r, `${p.name}叫:${q} 個 ${f} 點`);
  r.turn = aliveFrom(r, r.turn + 1);
  startTurn(r); push(r);
}
function liarChallenge(r, p) {
  if (r.phase !== 'play' || !r.bid) return push(r);
  clearTimeout(r.timer);
  const { q, f } = r.bid;
  const count = r.players.reduce((s, x) => s + x.dice.filter(d => d === f || (d === 1 && f !== 1)).length, 0);
  const ok = count >= q;   // 場上數量夠:叫牌成立,開牌的人敗;不夠:叫牌的人敗
  const bidder = r.players.find(x => x.id === r.bid.by);
  const loser = ok ? p : bidder;
  r.showAll = true; r.phase = 'over'; r.turn = -1; r.deadline = 0;
  r.loser = loser ? loser.id : null; r.loserName = loser ? loser.name : '';
  r.result = `${p.name}開牌!全場有 ${count} 個 ${f} 點${f === 1 ? '' : '(含百搭 1)'},${r.bid.name}叫了 ${q} 個,叫牌${ok ? '成立' : '不成立'}。` + (loser ? `${loser.name}敗!` : '叫牌的人已離開。');
  log(r, r.result); push(r);
}
function endLiar(r) {
  clearTimeout(r.timer);
  r.phase = 'over'; r.turn = -1; r.deadline = 0; r.loser = null; r.loserName = ''; r.result = '';
  log(r, '有玩家離開,遊戲結束'); push(r);
}

/* ---------- 房間管理 ---------- */
function removePlayer(r, id) {
  const idx = r.players.findIndex(p => p.id === id);
  if (idx < 0) return;
  const cur = r.players[r.turn];
  if (r.players[idx].res) try { r.players[idx].res.end(); } catch (e) { }
  r.players.splice(idx, 1);
  if (!r.players.length) { clearTimeout(r.timer); rooms.delete(r.code); return; }
  if (r.host === id) r.host = r.players[0].id;
  if (r.mode === 'liar') {
    if (r.phase === 'play') {
      if (r.players.length < 2) { endLiar(r); return; }
      if (cur && cur.id === id) { r.turn = idx % r.players.length; startTurn(r); }
      else r.turn = r.players.indexOf(cur);
    }
    push(r); return;
  }
  if (r.phase === 'play') {
    if (r.players.length < 2) { r.phase = 'over'; r.turn = -1; r.reveal = -1; r.lost = []; r.msg = '有玩家離開,遊戲結束'; clearTimeout(r.timer); }
    else if (cur && cur.id === id) { r.turn = idx % r.players.length; r.reveal = r.players[r.turn].dice.length > 1 ? r.turn : -1; if (!r.busy) startTurn(r); }
    else r.turn = r.players.indexOf(cur);
  }
  push(r);
}

function act(r, p, b) {
  r.last = Date.now();
  const isHost = r.host === p.id, liar = r.mode === 'liar', myTurn = r.players[r.turn] === p;
  if (b.t === 'start' && isHost && r.phase === 'lobby' && r.players.length > 1) {
    r.logs = []; r.lost = []; r.lostIds = []; r.winner = '';
    if (liar) { r.players.forEach(x => x.cnt = 5); liarRound(r, 0); return; }
    r.players.forEach(x => x.dice = hand());
    r.phase = 'play'; r.turn = 0; r.reveal = 0; log(r, `輪到${r.players[0].name}`);
    startTurn(r);
  } else if (b.t === 'again' && isHost && r.phase === 'over') {
    r.players.filter(x => !x.res).forEach(x => removePlayer(r, x.id));
    if (!rooms.has(r.code)) return;
    clearTimeout(r.timer);
    r.phase = 'lobby'; r.turn = -1; r.reveal = -1; r.msg = ''; r.logs = []; r.bid = null; r.showAll = false;
    r.loser = null; r.loserName = ''; r.lost = []; r.lostIds = []; r.winner = ''; r.result = ''; r.deadline = 0;
    r.players.forEach(x => { x.dice = []; x.cnt = 0; });
  } else if (!liar && b.t === 'call' && r.phase === 'play' && !r.busy && myTurn && CATS[b.k]) {
    call(r, b.k); return;
  } else if (liar && b.t === 'bid' && r.phase === 'play' && myTurn) {
    liarBid(r, p, +b.q, +b.f); return;
  } else if (liar && b.t === 'challenge' && r.phase === 'play' && myTurn) {
    liarChallenge(r, p); return;
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
        const r = newRoom(Math.min(8, Math.max(2, +b.max || 2)), b.mode === 'liar' ? 'liar' : 'rb');
        r.players.push({ id: pid, name: clean(b.name), dice: [], cnt: 0, res: null }); r.host = pid;
        return json(res, 200, { room: r.code });
      }
      const r = rooms.get(String(b.room || ''));
      if (!r) return json(res, 404, { error: '找不到房間,請確認代碼' });
      const p = r.players.find(x => x.id === pid);
      if (u.pathname === '/api/join') {
        if (!p) {
          if (r.phase !== 'lobby') return json(res, 409, { error: '遊戲已經開始了' });
          if (r.players.length >= r.max) return json(res, 409, { error: '房間已滿' });
          r.players.push({ id: pid, name: clean(b.name), dice: [], cnt: 0, res: null });
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
}).listen(PORT, () => console.log('骰子遊戲 running on http://localhost:' + PORT));

setInterval(() => {   // 保持連線 + 清除閒置房間
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.last > 3 * 3600e3) { clearTimeout(r.timer); r.players.forEach(p => p.res && p.res.end()); rooms.delete(code); continue; }
    r.players.forEach(p => p.res && p.res.write(':\n\n'));
  }
}, 20000);
