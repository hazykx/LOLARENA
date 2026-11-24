// Testovací boti: přihlásí N falešných hráčů (DEV_LOGIN=true), připojí je do fronty,
// automaticky přijmou hru a jako kapitáni náhodně draftují.
//   node scripts/simulate.js            → 9 botů (ty jsi 10. hráč – připoj se na SUPPORT)
//   node scripts/simulate.js 10         → 10 botů, celý flow proběhne sám
const { io } = require('socket.io-client');

const COUNT = Number(process.argv[2]) || 9;
const OFFSET = Number(process.env.OFFSET) || 0;   // OFFSET=7 → začne Bot8 (ADC)
const PASSIVE = process.env.PASSIVE === '1';      // boti v draftu nevolí (můžeš draftovat za ně v prohlížeči)
const BASE = process.argv[3] || process.env.BASE_URL || 'http://localhost:3000';
const ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bot(i) {
  const name = `Bot${i + 1}`;
  const role = ROLES[Math.floor(i / 2) % 5];
  const res = await fetch(`${BASE}/auth/dev?name=${name}`, { redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Nepřišla cookie – je zapnutý DEV_LOGIN=true?');
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
  const socket = io(BASE, { extraHeaders: { cookie } });
  const done = new Set();

  const act = (st) => {
    if (PASSIVE || !st || st.phase === 'done' || st.captains[st.actor].id !== me.id) return;
    const key = `${st.phase}-${st.round}`;
    if (done.has(key)) return;
    done.add(key);
    setTimeout(() => {
      let payload;
      if (st.phase === 'choice') payload = { value: Math.random() < 0.5 ? 'pick' : 'side' };
      else if (st.phase === 'side') payload = { value: Math.random() < 0.5 ? 'BLUE' : 'RED' };
      else { const all = Object.values(st.pool).flat(); payload = { userId: all[Math.floor(Math.random() * all.length)].id }; }
      socket.emit('draft_action', { id: st.id, ...payload }, (r) => r?.error && console.log(name, r.error));
    }, 800 + Math.random() * 1200);
  };

  socket.on('connect', () => socket.emit('queue_join', { role }, (r) => console.log(`${name} (${role})`, r?.error || 've frontě')));
  socket.on('ready_check', (rc) => { if (!rc.you) setTimeout(() => socket.emit('ready_respond', { id: rc.id, accept: true }), 300 + Math.random() * 1500); });
  socket.on('draft_start', ({ id }) => socket.emit('draft_join', { id }, (r) => {
    act(r.state);
    if (Math.random() < 0.4) socket.emit('draft_chat', { id, channel: 'all', text: `gl hf od ${name}` });
  }));
  socket.on('draft_state', act);
  socket.on('draft_done', ({ matchId }) => console.log(`${name}: zápas #${matchId} vytvořen`));
}

(async () => {
  for (let i = OFFSET; i < OFFSET + COUNT; i++) { await bot(i); await sleep(150); }
  console.log(`${COUNT} botů běží. Ctrl+C pro ukončení.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
