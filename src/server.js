const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./db');
const bot = require('./bot');
const game = require('./game');
const results = require('./results');
const riot = require('./riot');
const SqliteStore = require('./session-store');

if (config.onRailway && !config.persistentStorage) {
  console.warn('⚠️  Běžíš na Railway bez volume – databáze se při každém redeployi SMAŽE. Připoj volume (např. /data).');
}

// SESSION_SECRET: z .env, jinak se jednou vygeneruje a uloží do DB (přežije redeploy, pokud je DB na volume)
function sessionSecret() {
  if (config.sessionSecret) return config.sessionSecret;
  let s = db.getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); db.setSetting('session_secret', s); }
  return s;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
game.init(io);

app.set('trust proxy', 1);
app.get('/health', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); }
});

const sessionMiddleware = session({
  store: new SqliteStore(db),
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 86400000, sameSite: 'lax', secure: config.baseUrl.startsWith('https') },
});
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
io.engine.use(sessionMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });
const isAdmin = (uid) => config.admins.includes(uid);
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const getAccounts = (uid) => db.prepare(
  'SELECT id, game_name, tag_line, region, is_main, puuid IS NOT NULL AS verified FROM lol_accounts WHERE user_id = ? ORDER BY is_main DESC, id',
).all(uid);

function upsertUser(id, username, avatar) {
  db.prepare(`INSERT INTO users (id, username, avatar, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar`)
    .run(id, username, avatar, Date.now());
}

function auth(req, res, next) {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u) return res.status(401).json({ error: 'Nejsi přihlášený.' });
  req.user = u;
  next();
}
const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') {
      out.then((v) => !res.headersSent && res.json(v ?? { ok: true }))
        .catch((e) => res.status(e.status || 400).json({ error: e.message }));
    } else if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 400).json({ error: e.message });
  }
};

// ─────────────── Discord OAuth ───────────────
app.get('/auth/discord', (req, res) => {
  if (!config.discord.clientId) return res.status(500).send('Chybí DISCORD_CLIENT_ID v .env');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const p = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: `${config.baseUrl}/auth/discord/callback`,
    response_type: 'code', scope: 'identify', state, prompt: 'none',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${p}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) return res.redirect('/?error=oauth');
  delete req.session.oauthState;
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId, client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code', code: String(code),
        redirect_uri: `${config.baseUrl}/auth/discord/callback`,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const token = await tokenRes.json();
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!meRes.ok) throw new Error(`users/@me ${meRes.status}`);
    const du = await meRes.json();
    const avatar = du.avatar ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png?size=128` : null;
    upsertUser(du.id, du.global_name || du.username, avatar);
    req.session.userId = du.id;
    res.redirect('/');
  } catch (e) {
    console.error('[oauth]', e.message);
    res.redirect('/?error=oauth');
  }
});

// Testovací přihlášení bez Discordu (jen když DEV_LOGIN=true)
if (config.devLogin) {
  app.get('/auth/dev', (req, res) => {
    const name = String(req.query.name || '').replace(/[^\w-]/g, '').slice(0, 16);
    if (name.length < 2) return res.status(400).send('Zadej ?name=');
    const id = `dev-${name.toLowerCase()}`;
    upsertUser(id, name, null);
    if (!db.prepare('SELECT 1 FROM lol_accounts WHERE user_id = ?').get(id)) {
      db.prepare(`INSERT INTO lol_accounts (user_id, game_name, tag_line, region, is_main, created_at)
        VALUES (?, ?, 'DEV', 'EUNE', 1, ?)`).run(id, name, Date.now());
    }
    req.session.userId = id;
    res.redirect('/');
  });
}

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ─────────────── API ───────────────
app.get('/api/config', (req, res) => res.json({
  roles: config.roles, regions: config.regions, mainRegion: config.mainRegion,
  devLogin: config.devLogin, timers: config.timers,
}));

app.get('/api/me', (req, res) => {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u) return res.json({ user: null });
  res.json({ user: { ...u, isAdmin: isAdmin(u.id) }, accounts: getAccounts(u.id), status: game.getUserStatus(u.id) });
});

app.post('/api/me/accounts', auth, wrap(async (req) => {
  let { gameName, tagLine, region } = req.body || {};
  gameName = String(gameName || '').trim();
  tagLine = String(tagLine || '').trim().replace(/^#/, '');
  region = String(region || '').toUpperCase();
  if (gameName.length < 3 || gameName.length > 16) throw new Error('Jméno (Riot ID) musí mít 3–16 znaků.');
  if (!/^[\p{L}\p{N}]{2,5}$/u.test(tagLine)) throw new Error('Tag musí mít 2–5 písmen/číslic (např. EUNE).');
  if (!config.regions.includes(region)) throw new Error('Neplatný region.');
  const accounts = getAccounts(req.user.id);
  if (accounts.length >= 3) throw new Error('Můžeš mít maximálně 3 účty.');

  const lookup = await riot.lookupRiotId(gameName, tagLine);
  if (lookup.notFound) throw new Error(`Účet ${gameName}#${tagLine} neexistuje.`);
  if (lookup.gameName) { gameName = lookup.gameName; tagLine = lookup.tagLine; }

  const makeMain = region === config.mainRegion && !accounts.some((a) => a.is_main) ? 1 : 0;
  try {
    db.prepare(`INSERT INTO lol_accounts (user_id, game_name, tag_line, region, puuid, is_main, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, gameName, tagLine, region, lookup.puuid || null, makeMain, Date.now());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('Tento účet už je přidaný (u tebe nebo u jiného hráče).');
    throw e;
  }
  return { accounts: getAccounts(req.user.id) };
}));

app.delete('/api/me/accounts/:id', auth, wrap((req) => {
  const acc = db.prepare('SELECT * FROM lol_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!acc) throw new Error('Účet nenalezen.');
  if (acc.is_main && game.getUserStatus(req.user.id).activeMatch) throw new Error('Hlavní účet nejde odebrat během zápasu.');
  db.prepare('DELETE FROM lol_accounts WHERE id = ?').run(acc.id);
  if (acc.is_main) {
    const next = db.prepare('SELECT id FROM lol_accounts WHERE user_id = ? AND region = ? ORDER BY id LIMIT 1')
      .get(req.user.id, config.mainRegion);
    if (next) db.prepare('UPDATE lol_accounts SET is_main = 1 WHERE id = ?').run(next.id);
    else game.leaveQueue(req.user.id);
  }
  return { accounts: getAccounts(req.user.id) };
}));

app.post('/api/me/accounts/:id/main', auth, wrap((req) => {
  const acc = db.prepare('SELECT * FROM lol_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!acc) throw new Error('Účet nenalezen.');
  if (acc.region !== config.mainRegion) throw new Error(`Hlavní účet musí být ${config.mainRegion}.`);
  db.transaction(() => {
    db.prepare('UPDATE lol_accounts SET is_main = 0 WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE lol_accounts SET is_main = 1 WHERE id = ?').run(acc.id);
  })();
  return { accounts: getAccounts(req.user.id) };
}));

app.get('/api/users/:id', wrap((req) => {
  const u = getUser(req.params.id);
  if (!u) throw Object.assign(new Error('Hráč neexistuje.'), { status: 404 });
  const stats = db.prepare(`SELECT COUNT(*) games, SUM(p.win) wins, SUM(p.kills) kills, SUM(p.deaths) deaths,
      SUM(p.assists) assists, AVG(p.cs) cs, AVG(p.damage) damage, AVG(p.vision) vision
    FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? AND m.status = 'finished'`).get(u.id);
  const roles = db.prepare(`SELECT p.role, COUNT(*) games, SUM(p.win) wins FROM match_players p JOIN matches m ON m.id = p.match_id
    WHERE p.user_id = ? AND m.status = 'finished' GROUP BY p.role ORDER BY games DESC`).all(u.id);
  const champions = db.prepare(`SELECT p.champion, COUNT(*) games, SUM(p.win) wins FROM match_players p JOIN matches m ON m.id = p.match_id
    WHERE p.user_id = ? AND m.status = 'finished' AND p.champion IS NOT NULL GROUP BY p.champion ORDER BY games DESC LIMIT 5`).all(u.id);
  const history = db.prepare(`SELECT m.id, m.status, m.winner, m.created_at, m.game_duration, p.team, p.role, p.is_captain,
      p.champion, p.kills, p.deaths, p.assists, p.cs, p.win, p.elo_before, p.elo_after
    FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? AND m.status != 'cancelled'
    ORDER BY m.id DESC LIMIT 20`).all(u.id);
  const rank = db.prepare('SELECT COUNT(*) + 1 r FROM users WHERE elo > ? AND wins + losses > 0').get(u.elo).r;
  const isMe = req.session.userId === u.id;
  return {
    user: { id: u.id, username: u.username, avatar: u.avatar, elo: u.elo, wins: u.wins, losses: u.losses, created_at: u.created_at },
    rank: u.wins + u.losses > 0 ? rank : null,
    accounts: getAccounts(u.id), stats, roles, champions, history, isMe,
  };
}));

app.get('/api/leaderboard', wrap(() => ({
  players: db.prepare(`SELECT id, username, avatar, elo, wins, losses FROM users WHERE wins + losses > 0
    ORDER BY elo DESC, wins DESC LIMIT 200`).all(),
})));

function matchSummary(m) {
  const players = db.prepare(`SELECT p.user_id, p.team, p.role, p.is_captain, u.username, u.avatar
    FROM match_players p JOIN users u ON u.id = p.user_id WHERE p.match_id = ?`).all(m.id);
  return { id: m.id, status: m.status, winner: m.winner, created_at: m.created_at, finished_at: m.finished_at, players };
}
app.get('/api/matches', wrap(() => ({
  active: db.prepare(`SELECT * FROM matches WHERE status IN ('in_progress','awaiting_confirm','disputed') ORDER BY id DESC`).all().map(matchSummary),
  recent: db.prepare(`SELECT * FROM matches WHERE status IN ('finished','cancelled') ORDER BY id DESC LIMIT 30`).all().map(matchSummary),
})));

app.get('/api/matches/:id', wrap((req) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) throw Object.assign(new Error('Zápas neexistuje.'), { status: 404 });
  const uid = req.session.userId;
  const admin = uid && isAdmin(uid);
  const players = db.prepare(`SELECT p.*, u.username, u.avatar, u.elo AS current_elo,
      (SELECT game_name || '#' || tag_line FROM lol_accounts a WHERE a.user_id = p.user_id AND a.is_main = 1) AS riot_id
    FROM match_players p JOIN users u ON u.id = p.user_id WHERE p.match_id = ?
    ORDER BY CASE p.role WHEN 'TOP' THEN 1 WHEN 'JUNGLE' THEN 2 WHEN 'MID' THEN 3 WHEN 'ADC' THEN 4 ELSE 5 END`).all(m.id);
  const me = players.find((p) => p.user_id === uid);
  const myTeam = me?.team || null;
  const captainSide = m.blue_captain === uid ? 'BLUE' : m.red_captain === uid ? 'RED' : null;
  const pending = m.pending_json ? JSON.parse(m.pending_json) : null;
  const loserCaptain = pending ? (pending.winner === 'BLUE' ? m.red_captain : m.blue_captain) : null;
  const voice = m.voice_json ? JSON.parse(m.voice_json) : null;
  const live = !['finished', 'cancelled'].includes(m.status);
  const draft = m.draft_json ? JSON.parse(m.draft_json) : null;

  return {
    match: {
      id: m.id, status: m.status, winner: m.winner, captainRole: m.captain_role,
      blueCaptain: m.blue_captain, redCaptain: m.red_captain,
      created_at: m.created_at, finished_at: m.finished_at, duration: m.game_duration,
      lobby: (me || admin) && live ? { name: m.lobby_name, password: m.lobby_password } : null,
      voice: live && voice ? (admin ? voice : myTeam ? { [myTeam]: voice[myTeam] } : null) : null,
      pending: pending && (me || admin) ? { winner: pending.winner, duration: pending.duration, stats: pending.stats } : null,
      reportedBy: m.reported_by, loserCaptain, draftLog: draft?.log || [],
    },
    players,
    viewer: {
      isParticipant: !!me, myTeam, captainSide, isAdmin: !!admin,
      canUpload: ['in_progress', 'disputed'].includes(m.status) && (!!captainSide || !!admin),
      canConfirm: m.status === 'awaiting_confirm' && (uid === loserCaptain || !!admin),
    },
  };
}));

app.post('/api/matches/:id/result', auth, upload.single('rofl'), wrap((req) => (
  results.uploadResult(Number(req.params.id), req.user.id, req.file?.buffer, isAdmin(req.user.id))
)));
app.post('/api/matches/:id/confirm', auth, wrap((req) => results.confirmResult(Number(req.params.id), req.user.id, isAdmin(req.user.id))));
app.post('/api/matches/:id/dispute', auth, wrap((req) => results.disputeResult(Number(req.params.id), req.user.id, isAdmin(req.user.id))));
app.post('/api/matches/:id/cancel', auth, wrap((req) => {
  if (!isAdmin(req.user.id)) throw Object.assign(new Error('Jen pro adminy.'), { status: 403 });
  return results.cancelMatch(Number(req.params.id));
}));

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Soubor je moc velký.' });
  console.error(err);
  res.status(500).json({ error: 'Chyba serveru.' });
});

// ─────────────── Socket.IO ───────────────
io.on('connection', (socket) => {
  const uid = socket.request.session?.userId;
  const user = uid && getUser(uid);
  if (user) {
    socket.join(game.userRoom(uid));
    game.onConnect(socket, uid);
  }
  socket.emit('queue_state', game.queueSnapshot());

  const handle = (event, fn, needAuth = true) => socket.on(event, (data, ack) => {
    const cb = typeof ack === 'function' ? ack : () => {};
    if (needAuth && !user) return cb({ error: 'Nejsi přihlášený.' });
    try { cb(fn(data || {}) || { ok: true }); } catch (e) { cb({ error: e.message }); }
  });

  handle('queue_join', ({ role }) => game.joinQueue(uid, role));
  handle('queue_leave', () => { game.leaveQueue(uid); });
  handle('ready_respond', ({ id, accept }) => { game.respondReady(uid, id, !!accept); });
  handle('draft_join', ({ id }) => game.draftJoin(socket, uid, String(id)), false);
  handle('draft_action', ({ id, ...action }) => { game.draftAction(uid, String(id), action); });
  handle('draft_chat', ({ id, channel, text }) => { game.draftChat(uid, String(id), channel, text); });
  handle('match_join', ({ id }) => { socket.join(`match:${Number(id)}`); }, false);
  handle('match_leave', ({ id }) => { socket.leave(`match:${Number(id)}`); }, false);

  socket.on('disconnect', () => { if (user) game.onDisconnect(uid); });
});

server.listen(config.port, () => {
  console.log(`INHOUSE běží na ${config.baseUrl} (port ${config.port})${config.devLogin ? ' – DEV_LOGIN zapnutý' : ''}`);
  console.log(`Databáze: ${db.file}`);
});
bot.start().catch((e) => console.error('[bot] start selhal:', e.message));

// Railway při redeployi posílá SIGTERM – zavřeme spojení a databázi čistě
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} – vypínám…`);
  io.close();
  server.close();
  bot.stop().finally(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
