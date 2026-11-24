// Parser League of Legends replaye (.rofl).
// Metadata (vč. statistik hráčů) jsou v souboru jako JSON. Zkoušíme 3 strategie, aby to fungovalo
// pro starý formát (offsety v hlavičce) i nový (JSON na konci souboru + uint32 délka).

function tryParse(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && 'statsJson' in o ? o : null;
  } catch { return null; }
}

function extractJsonObject(str) {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return str.slice(0, i + 1);
  }
  return null;
}

function readMetadata(buf) {
  // 1) starý formát: RIOT\0\0 + 256B podpis + hlavička s offsetem metadat
  if (buf.length > 276) {
    const off = buf.readUInt32LE(268); const len = buf.readUInt32LE(272);
    if (off > 0 && len > 0 && off + len <= buf.length) {
      const m = tryParse(buf.toString('utf8', off, off + len));
      if (m) return m;
    }
  }
  // 2) nový formát: [... JSON metadata][uint32 délka]
  if (buf.length > 8) {
    const len = buf.readUInt32LE(buf.length - 4);
    if (len > 0 && len < buf.length - 4) {
      const m = tryParse(buf.toString('utf8', buf.length - 4 - len, buf.length - 4));
      if (m) return m;
    }
  }
  // 3) záloha: najít {"gameLength" a vyparsovat objekt
  const marker = Buffer.from('{"gameLength"');
  let idx = buf.lastIndexOf(marker);
  while (idx !== -1) {
    const s = extractJsonObject(buf.toString('utf8', idx, Math.min(buf.length, idx + 4_000_000)));
    const m = s && tryParse(s);
    if (m) return m;
    idx = idx > 0 ? buf.lastIndexOf(marker, idx - 1) : -1;
  }
  return null;
}

const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

function parseRofl(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) throw new Error('Soubor je prázdný nebo poškozený.');
  if (buf.toString('latin1', 0, 4) !== 'RIOT') throw new Error('Soubor není League of Legends replay (.rofl).');

  const meta = readMetadata(buf);
  if (!meta) throw new Error('V replayi se nepodařilo najít statistiky hry.');
  const raw = typeof meta.statsJson === 'string' ? JSON.parse(meta.statsJson) : meta.statsJson;
  if (!Array.isArray(raw)) throw new Error('Replay neobsahuje statistiky hráčů.');

  const players = raw.map((p) => ({
    name: p.NAME || '',
    gameName: p.RIOT_ID_GAME_NAME || p.NAME || '',
    tagLine: p.RIOT_ID_TAG_LINE || '',
    puuid: p.PUUID || null,
    team: String(p.TEAM) === '100' ? 'BLUE' : String(p.TEAM) === '200' ? 'RED' : null,
    win: String(p.WIN).toLowerCase() === 'win',
    champion: p.SKIN || p.CHAMPION || '',
    position: p.TEAM_POSITION || p.INDIVIDUAL_POSITION || '',
    kills: num(p.CHAMPIONS_KILLED),
    deaths: num(p.NUM_DEATHS),
    assists: num(p.ASSISTS),
    cs: num(p.MINIONS_KILLED) + num(p.NEUTRAL_MINIONS_KILLED),
    gold: num(p.GOLD_EARNED),
    damage: num(p.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
    vision: num(p.VISION_SCORE),
  }));
  if (players.length !== 10) throw new Error(`Replay obsahuje ${players.length} hráčů místo 10.`);

  return {
    gameLength: Math.round(num(meta.gameLength) / 1000), // sekundy
    gameVersion: meta.gameVersion || '',
    players,
  };
}

module.exports = { parseRofl };
