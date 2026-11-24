// Discord bot – voice roomky pro týmy, pozvánky, DM notifikace.
// Když není nastaven DISCORD_BOT_TOKEN, všechny funkce jsou no-op a web funguje dál.
const config = require('./config');

let client = null;
let ready = false;
let djs = null;

async function start() {
  if (!config.discord.botToken) {
    console.log('[bot] DISCORD_BOT_TOKEN není nastaven – bot je vypnutý (voice roomky se nevytvoří).');
    return;
  }
  djs = require('discord.js');
  client = new djs.Client({ intents: [djs.GatewayIntentBits.Guilds] });
  client.once(djs.Events.ClientReady, (c) => {
    ready = true;
    console.log(`[bot] Přihlášen jako ${c.user.tag}`);
  });
  client.on('error', (e) => console.error('[bot]', e.message));
  await client.login(config.discord.botToken);
}

async function getGuild() {
  if (!ready || !config.discord.guildId) return null;
  return client.guilds.fetch(config.discord.guildId).catch(() => null);
}

async function dm(userId, text) {
  if (!ready || !config.discord.sendDMs || userId.startsWith('dev-')) return;
  try {
    const u = await client.users.fetch(userId);
    await u.send(text);
  } catch { /* uživatel má zavřené DM */ }
}

async function announce(text) {
  if (!ready || !config.discord.announceChannelId) return;
  try {
    const ch = await client.channels.fetch(config.discord.announceChannelId);
    if (ch?.isTextBased()) await ch.send(text);
  } catch (e) { console.error('[bot] announce', e.message); }
}

async function notifyReadyCheck(userIds) {
  await Promise.all(userIds.map((id) => dm(id,
    `🔔 **Hra nalezena!** Máš ${config.timers.readyCheck} s na přijetí: ${config.baseUrl}`)));
}

// teams = { BLUE: [discordId...], RED: [...] }
async function createMatchVoice(match, teams) {
  const guild = await getGuild();
  if (!guild) return null;
  const { ChannelType, PermissionFlagsBits: P } = djs;
  const result = {};

  for (const side of ['BLUE', 'RED']) {
    const overwrites = [];
    if (config.discord.privateVoice) {
      overwrites.push({ id: guild.roles.everyone.id, deny: [P.Connect] });
      overwrites.push({ id: client.user.id, allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.CreateInstantInvite] });
      for (const uid of teams[side]) {
        const member = await guild.members.fetch(uid).catch(() => null);
        if (member) overwrites.push({ id: uid, allow: [P.ViewChannel, P.Connect, P.Speak] });
      }
    }
    const channel = await guild.channels.create({
      name: `#${match.id} ${side === 'BLUE' ? '🔵 Blue' : '🔴 Red'}`,
      type: ChannelType.GuildVoice,
      parent: config.discord.voiceCategoryId || undefined,
      permissionOverwrites: overwrites,
    });
    const invite = await channel.createInvite({ maxAge: 6 * 3600, maxUses: 0, unique: true });
    result[side] = { channelId: channel.id, invite: invite.url };
  }

  for (const side of ['BLUE', 'RED']) {
    for (const uid of teams[side]) {
      dm(uid, [
        `🎮 **Zápas #${match.id} je připraven** – hraješ za **${side}**`,
        `Lobby: \`${match.lobby_name}\`  ·  Heslo: \`${match.lobby_password}\``,
        `Voice: ${result[side].invite}`,
        `Detail: ${config.baseUrl}/#/match/${match.id}`,
      ].join('\n'));
    }
  }
  announce(`🎮 Zápas **#${match.id}** začíná – ${config.baseUrl}/#/match/${match.id}`);
  return result;
}

async function deleteMatchVoice(voiceJson) {
  if (!voiceJson || !ready) return;
  let voice;
  try { voice = JSON.parse(voiceJson); } catch { return; }
  for (const side of Object.keys(voice)) {
    try {
      const ch = await client.channels.fetch(voice[side].channelId);
      await ch?.delete('Zápas ukončen');
    } catch (e) { console.error('[bot] delete voice', e.message); }
  }
}

async function stop() {
  if (client) await client.destroy().catch(() => {});
}

module.exports = { start, stop, dm, announce, notifyReadyCheck, createMatchVoice, deleteMatchVoice };
