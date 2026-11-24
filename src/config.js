require('dotenv').config({ quiet: true });
const path = require('path');

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const port = Number(process.env.PORT) || 3000;

// Railway tyto proměnné nastavuje sám: doménu po "Generate Domain", cestu po připojení volume.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;

module.exports = {
  port,
  baseUrl: (process.env.BASE_URL || (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${port}`)).replace(/\/$/, ''),
  sessionSecret: process.env.SESSION_SECRET || '',   // prázdné = vygeneruje se a uloží do DB
  dbFile: process.env.DB_FILE || (volumePath ? path.join(volumePath, 'inhouse.db') : ''),
  onRailway: !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID),
  persistentStorage: !!(process.env.DB_FILE || volumePath),

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    voiceCategoryId: process.env.DISCORD_VOICE_CATEGORY_ID || '',
    announceChannelId: process.env.DISCORD_ANNOUNCE_CHANNEL_ID || '',
    privateVoice: process.env.PRIVATE_VOICE !== 'false',
    sendDMs: process.env.SEND_DMS !== 'false',
  },

  riotApiKey: process.env.RIOT_API_KEY || '',
  admins: list(process.env.ADMIN_DISCORD_IDS),
  devLogin: process.env.DEV_LOGIN === 'true',

  timers: {
    readyCheck: Number(process.env.READY_SECONDS) || 60,
    draftPick: Number(process.env.PICK_SECONDS) || 30,
    disconnectGrace: Number(process.env.DISCONNECT_GRACE_SECONDS) || 60,
  },

  elo: { start: 1000, k: Number(process.env.ELO_K) || 32 },

  roles: ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'],
  regions: ['EUNE', 'EUW', 'NA', 'KR', 'TR', 'RU', 'BR', 'LAN', 'LAS', 'OCE', 'JP'],
  mainRegion: 'EUNE',
};
