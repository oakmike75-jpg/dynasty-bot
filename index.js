const {Client,GatewayIntentBits,PermissionFlagsBits}=require('discord.js');
const cron=require('node-cron');
const Sleeper=require('./sleeper');
const {buildRulesEmbeds}=require('./rules');
const {postVotes}=require('./votes');
const {slugName,formatRosterEmbed,formatRosterDiff,formatTradeEmbed,formatStandingsEmbed,formatMaxPFEmbed}=require('./formatters');
require('dotenv').config();

// ── In-memory state (survives poll loops, resets on restart which is fine) ────
const mem={
  seenTransactions: {},
  rosterSnapshot:   {},
  rosterChannelMap: {},
  userMap:          {},
  rosterUserMap:    {},
  nflWeek:          1
};

const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildMessageReactions]});

function ch(guild,envKey){
  return guild.channels.cache.get(process.env[envKey])||null;
}

client.once('ready',async()=>{
  console.log('\n✅ Doug Da Dynasty Bot is online');
  const guild=client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if(!guild){console.error('❌ Guild not found');process.exit(1)}
  await setup(guild);
  await poll(guild);
  setInterval(()=>poll(guild),60000);
  cron.schedule('0 9 * * 2',async()=>{
    console.log('📰 Tuesday 9AM firing...');
    await postStandings(guild);
    await postMaxPF(guild);
  },{timezone:'America/New_York'});
  console.log('⏰ Scheduled: standings + Max PF every Tuesday 9 AM ET\n');
});

async function setup(guild){
  console.log('🔧 Running setup...');
  const id=process.env.SLEEPER_LEAGUE_ID;
  const [league,rosters,users,nfl]=await Promise.all([
    Sleeper.getLeague(id),Sleeper.getRosters(id),
    Sleeper.getUsers(id),Sleeper.getNFLState()
  ]);

  mem.nflWeek=nfl.week;
  users.forEach(u=>{mem.userMap[u.user_id]=u});
  rosters.forEach(r=>{
    mem.rosterUserMap[r.roster_id]=mem.userMap[r.owner_id]||{display_name:`Team ${r.roster_id}`,user_id:r.owner_id};
  });

  // Seed transactions so we don't re-post old trades on restart
  const tx=await Sleeper.getTransactions(id,nfl.week);
  tx.forEach(t=>{mem.seenTransactions[t.transaction_id]=true});
  console.log(`📌 Seeded ${tx.length} existing transactions`);

  // Seed roster snapshot
  rosters.forEach(r=>{mem.rosterSnapshot[r.roster_id]=r.players||[]});
  console.log('📌 Seeded roster snapshot');

  // Build roster channel map from env or by scanning Discord
  await buildRosterChannelMap(guild,rosters);

  // Post rules and votes only if channels are empty
  await postIfEmpty(guild);

  // Rename any roster channels that have real names now
  await updateRosterChannelNames(guild,rosters);

  console.log('✅ Setup complete — Doug is watching\n');
}

async function buildRosterChannelMap(guild,rosters){
  // First try env variable ROSTER_CHANNEL_MAP (JSON string)
  if(process.env.ROSTER_CHANNEL_MAP){
    try{
      Object.assign(mem.rosterChannelMap,JSON.parse(process.env.ROSTER_CHANNEL_MAP));
      console.log('📌 Roster channel map loaded from env');
      return;
    }catch{}
  }
  // Otherwise scan Discord for roster- channels
  console.log('📌 Building roster channel map from Discord...');
  rosters.forEach(r=>{
    const user=mem.rosterUserMap[r.roster_id];
    const expected=slugName(user);
    const generic=`roster-team-${r.roster_id}`;
    const found=guild.channels.cache.find(c=>c.name===expected||c.name===generic);
    if(found){
      mem.rosterChannelMap[r.roster_id]=found.id;
    }
  });
  // Print the map so you can add it to Railway env
  console.log('📋 ROSTER_CHANNEL_MAP (add this to Railway Variables):');
  console.log(JSON.stringify(mem.rosterChannelMap));
}

async function postIfEmpty(guild){
  // Rules channel — post if empty
  const rulesCh=ch(guild,'CHANNEL_RULES');
  if(rulesCh){
    const msgs=await rulesCh.messages.fetch({limit:5}).catch(()=>null);
    if(msgs&&msgs.size===0){
      const embeds=buildRulesEmbeds();
      for(let i=0;i<embeds.length;i+=10){
        const msg=await rulesCh.send({embeds:embeds.slice(i,i+10)});
        if(i===0)await msg.pin().catch(()=>{});
      }
      console.log('📜 Rules posted');
    } else {
      console.log('📜 Rules already posted — skipping');
    }
  }

  // Votes channel — post if empty
  const votesCh=ch(guild,'CHANNEL_LEAGUE_SETTING_OPTIONS');
  if(votesCh){
    const msgs=await votesCh.messages.fetch({limit:5}).catch(()=>null);
    if(msgs&&msgs.size===0){
      await postVotes(votesCh);
      console.log('🗳️ Votes posted');
    } else {
      console.log('🗳️ Votes already posted — skipping');
    }
  }
}

async function updateRosterChannelNames(guild,rosters){
  for(const r of rosters){
    const user=mem.rosterUserMap[r.roster_id];
    const expected=slugName(user);
    const chId=mem.rosterChannelMap[r.roster_id];
    if(!chId)continue;
    const channel=guild.channels.cache.get(chId);
    if(!channel||channel.name===expected)continue;
    await channel.setName(expected).catch(()=>{});
    console.log(`  ✏️ Renamed → #${expected}`);
  }
}

async function poll(guild){
  try{
    const id=process.env.SLEEPER_LEAGUE_ID,week=mem.nflWeek;
    await pollTransactions(guild,id,week);
    await pollRosterChanges(guild,id);
  }catch(err){console.error('❌ Poll error:',err.message)}
}

async function pollTransactions(guild,id,week){
  const all=await Sleeper.getTransactions(id,week);
  const fresh=all.filter(t=>!mem.seenTransactions[t.transaction_id]);
  if(!fresh.length)return;
  const players=await Sleeper.getAllPlayers();
  const tradeCh=ch(guild,'CHANNEL_TRADE_ALERTS');
  for(const tx of fresh){
    mem.seenTransactions[tx.transaction_id]=true;
    if(tx.type==='trade'&&tx.status==='complete'&&tradeCh){
      const msg=await tradeCh.send({embeds:[formatTradeEmbed(tx,mem.rosterUserMap,players)]});
      await msg.react('✅').catch(()=>{});
      await msg.react('❌').catch(()=>{});
      await msg.react('🤷').catch(()=>{});
      console.log(`🔄 Trade posted TX ${tx.transaction_id}`);
    }
  }
}

async function pollRosterChanges(guild,id){
  const rosters=await Sleeper.getRosters(id);
  const players=await Sleeper.getAllPlayers();
  let renamed=false;
  for(const r of rosters){
    const prev=mem.rosterSnapshot[r.roster_id]||[];
    const curr=r.players||[];
    const added=curr.filter(p=>!prev.includes(p));
    const dropped=prev.filter(p=>!curr.includes(p));

    // Check if username changed and rename channel
    const user=mem.rosterUserMap[r.roster_id];
    const newUser=mem.userMap[r.owner_id];
    if(newUser&&newUser.display_name!==user.display_name){
      mem.rosterUserMap[r.roster_id]=newUser;
      await updateRosterChannelNames(guild,rosters);
      renamed=true;
    }

    if(!added.length&&!dropped.length)continue;
    const chId=mem.rosterChannelMap[r.roster_id];
    const channel=chId?guild.channels.cache.get(chId):null;
    if(channel){
      await channel.send({embeds:[formatRosterDiff(user,added,dropped,players)]});
      console.log(`📝 Roster move: ${user.display_name}`);
    }
    mem.rosterSnapshot[r.roster_id]=curr;
  }
}

async function postStandings(guild){
  try{
    const id=process.env.SLEEPER_LEAGUE_ID,week=mem.nflWeek;
    const [rosters,users,matchups,next]=await Promise.all([
      Sleeper.getRosters(id),Sleeper.getUsers(id),
      Sleeper.getMatchups(id,week).catch(()=>[]),
      Sleeper.getMatchups(id,week+1).catch(()=>[])
    ]);
    const um={};users.forEach(u=>{um[u.user_id]=u});
    const channel=ch(guild,'CHANNEL_STANDINGS');
    if(!channel)return;
    await channel.send({embeds:[formatStandingsEmbed(rosters,um,matchups,next,week)]});
    console.log(`📰 Standings posted week ${week}`);
  }catch(err){console.error('❌ Standings:',err.message)}
}

async function postMaxPF(guild){
  try{
    const id=process.env.SLEEPER_LEAGUE_ID,week=mem.nflWeek;
    const [rosters,users]=await Promise.all([Sleeper.getRosters(id),Sleeper.getUsers(id)]);
    const um={};users.forEach(u=>{um[u.user_id]=u});
    const channel=ch(guild,'CHANNEL_MAX_POINTS_TRACKER');
    if(!channel)return;
    await channel.send({embeds:[formatMaxPFEmbed(rosters,um,week)]});
    console.log(`💥 Max PF posted week ${week}`);
  }catch(err){console.error('❌ MaxPF:',err.message)}
}

client.login(process.env.DISCORD_BOT_TOKEN);
