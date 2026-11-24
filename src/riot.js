// Volitelné ověření Riot ID přes Riot API (když je nastaven RIOT_API_KEY).
const config = require('./config');

async function lookupRiotId(gameName, tagLine) {
  if (!config.riotApiKey) return { skipped: true };
  const url = `https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  try {
    const r = await fetch(url, { headers: { 'X-Riot-Token': config.riotApiKey } });
    if (r.status === 404) return { notFound: true };
    if (!r.ok) { console.warn('[riot] API vrátilo', r.status, '– ověření přeskočeno'); return { skipped: true }; }
    return await r.json(); // { puuid, gameName, tagLine }
  } catch (e) {
    console.warn('[riot] chyba', e.message);
    return { skipped: true };
  }
}

module.exports = { lookupRiotId };
