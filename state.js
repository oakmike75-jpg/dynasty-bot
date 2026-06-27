const {Client,GatewayIntentBits}=require('discord.js');
const cron=require('node-cron');
const Sleeper=require('./sleeper'),State=require('./state');
const {buildRulesEmbeds}=require('./rules');
const {postVotes}=require('./votes');
const {slugName,formatRosterEmbed,formatRosterDiff,formatTradeEmbed,formatStandingsEmbed,formatMaxPFEmbed}=require('./formatters');
require('dotenv').config();

const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildMessageReactions]});

// ── Channel IDs hardcoded from .env — Doug NEVER creates channels ─────────────
function getChannels(guild){
  return {
    rules:        guild.channels.cache.get(process.env.CHANNEL_RULES),
    tradeAlerts:  guild.channels.cache.get(process.env.CHANNEL_TRADE_ALERTS),
    leagueOptions:guild.channels.cache.get(process.env.CHANNEL_LEAGUE_SETTING_OPTIONS),
    standings:    guild.channels.cache.get(process.env.CHANNEL_STANDINGS),
    maxPF:        guild.channels.cache.get(process.env.CHANNEL_MAX_POINTS_TRACKER)
  };
}

client.once('ready',async()=>{
  console.log('\n✅ Doug Da Dynasty Bot is online');
  const guild=client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if(!guild){console.error('❌ Guild not found');process.exit(1)}
  await setup(guild);
  await poll(guild);
  setInterval(()=>poll(guild),60000);
  cron.schedule('0 9 * * 2',async()=>{
    console.log('📰 Tuesday 9AM — posting standings and Max PF...');
    await postStandings(guild);
    await postMaxPF(guild);
  },{timezone:'America/New_York'});
  console.log('⏰ Scheduled: standings + Max PF every Tuesday 9 AM ET\n');
});

async function setup(guild){
  console.log('🔧 Running setup...');
  const id=process.env.SLEEPER_LEAGUE_ID;
  const [league,rosters,users,nfl]=await Promise.all([Sleeper.getLeague(id),Sleeper.getRosters(id),Sleeper.getUsers(id),Sleeper.getNFLState()]);
  State.set('nflWeek',nfl.week);
  const um={};users.forEach(u=>{um[u.user_id]=u});State.set('userMap',um);
  const rum={};rosters.forEach(r=>{rum[r.roster_id]=um[r.owner_id]||{display_name:`Team ${r.roster_id}`,user_id:r.owner_id}});State.set('rosterUserMap',rum);

  // Seed seen transactions so nothing gets duplicated on restart
  if(!State.get('seenTransactions')){
    const tx=await Sleeper.getTransactions(id,nfl.week);
    const seen={};tx.forEach(t=>{seen[t.transaction_id]=true});
    State.set('seenTransactions',seen);
    console.log(`📌 Seeded ${Object.keys(seen).length} existing transactions`);
  }

  // Seed roster snapshot
  if(!State.get('rosterSnapshot')){
    const snap={};rosters.forEach(r=>{snap[r.roster_id]=r.players||[]});
    State.set('rosterSnapshot',snap);
    console.log('📌 Seeded roster snapshot');
  }

  // Post rules and votes only once ever
  if(!State.get('contentPosted')){
    const chs=getChannels(guild);
    await postRules(chs.rules);
    await postVotesToChannel(chs.leagueOptions);
    State.set('contentPosted',true);
  }

  // Update roster channel names if Sleeper usernames changed
  await updateRosterChannelNames(guild,rosters,rum);

  console.log('✅ Setup complete — Doug is watching\n');
}

async function postRules(ch){
  if(!ch){console.log('⚠️ Rules channel not found');return;}
  try{const m=await ch.messages.fetch({limit:50});if(m.size)await ch.bulkDelete(m).catch(()=>{})}catch{}
  const embeds=buildRulesEmbeds();
  for(let i=0;i<embeds.length;i+=10){const msg=await ch.send({embeds:embeds.slice(i,i+10)});if(i===0)await msg.pin().catch(()=>{})}
  console.log('📜 Rules posted');
}

async function postVotesToChannel(ch){
  if(!ch){console.log('⚠️ League options channel not found');return;}
  try{const m=await ch.messages.fetch({limit:50});if(m.size)await ch.bulkDelete(m).catch(()=>{})}catch{}
  await postVotes(ch);
  console.log('🗳️ Votes posted');
}

// Update roster channel names when Sleeper usernames come in
async function updateRosterChannelNames(guild,rosters,rum){
  const cm=State.get('rosterChannelMap')||{};
  let updated=false;
  for(const r of rosters){
    const user=rum[r.roster_id];
    const expected=slugName(user);
    const chId=cm[r.roster_id];
    if(!chId)continue;
    const ch=guild.channels.cache.get(chId);
    if(!ch||ch.name===expected)continue;
    await ch.setName(expected).catch(()=>{});
    console.log(`  ✏️ Renamed roster channel → #${expected}`);
    updated=true;
  }
  if(updated)State.set('rosterChannelMap',cm);
}

async function poll(guild){
  try{
    const id=process.env.SLEEPER_LEAGUE_ID,week=State.get('nflWeek');
    await pollTransactions(guild,id,week);
    await pollRosterChanges(guild,id);
  }catch(err){console.error('❌ Poll error:',err.message)}
}

async function pollTransactions(guild,id,week){
  const all=await Sleeper.getTransactions(id,week);
  const seen=State.get('seenTransactions')||{};
  const fresh=all.filter(t=>!seen[t.transaction_id]);
  if(!fresh.length)return;
  const players=await Sleeper.getAllPlayers(),rum=State.get('rosterUserMap');
  const ch=getChannels(guild).tradeAlerts;
  for(const tx of fresh){
    seen[tx.transaction_id]=true;
    if(tx.type==='trade'&&tx.status==='complete'){
      if(ch){
        const msg=await ch.send({embeds:[formatTradeEmbed(tx,rum,players)]});
        await msg.react('✅').catch(()=>{});
        await msg.react('❌').catch(()=>{});
        await msg.react('🤷').catch(()=>{});
        console.log(`🔄 Trade posted TX ${tx.transaction_id}`);
      }
    }
  }
  State.set('seenTransactions',seen);
}

async function pollRosterChanges(guild,id){
  const rosters=await Sleeper.getRosters(id);
  const snap=State.get('rosterSnapshot')||{};
  const rum=State.get('rosterUserMap');
  const players=await Sleeper.getAllPlayers();
  const cm=State.get('rosterChannelMap')||{};
  let changed=false;
  for(const r of rosters){
    const prev=snap[r.roster_id]||[],curr=r.players||[];
    const added=curr.filter(p=>!prev.includes(p)),dropped=prev.filter(p=>!curr.includes(p));
    if(!added.length&&!dropped.length)continue;
    const user=rum[r.roster_id];
    const chId=cm[r.roster_id];
    const ch=chId?guild.channels.cache.get(chId):null;
    if(ch){
      await ch.send({embeds:[formatRosterDiff(user,added,dropped,players)]});
      console.log(`📝 Roster move: ${user.display_name}`);
    }
    snap[r.roster_id]=curr;changed=true;
  }
  if(changed)State.set('rosterSnapshot',snap);
}

async function postStandings(guild){
  try{
    const id=process.env.SLEEPER_LEAGUE_ID,week=State.get('nflWeek');
    const [rosters,users,matchups,next]=await Promise.all([Sleeper.getRosters(id),Sleeper.getUsers(id),Sleeper.getMatchups(id,week).catch(()=>[]),Sleeper.getMatchups(id,week+1).catch(()=>[])]);
    const um={};users.forEach(u=>{um[u.user_id]=u});
    const ch=getChannels(guild).standings;
    if(!ch)return;
    await ch.send({embeds:[formatStandingsEmbed(rosters,um,matchups,next,week)]});
    console.log(`📰 Standings posted week ${week}`);
  }catch(err){console.error('❌ Standings error:',err.message)}
}

async function postMaxPF(guild){
  try{
    const id=process.env.SLEEPER_LEAGUE_ID,week=State.get('nflWeek');
    const [rosters,users]=await Promise.all([Sleeper.getRosters(id),Sleeper.getUsers(id)]);
    const um={};users.forEach(u=>{um[u.user_id]=u});
    const ch=getChannels(guild).maxPF;
    if(!ch)return;
    await ch.send({embeds:[formatMaxPFEmbed(rosters,um,week)]});
    console.log(`💥 Max PF posted week ${week}`);
  }catch(err){console.error('❌ Max PF error:',err.message)}
}

client.login(process.env.DISCORD_BOT_TOKEN);
