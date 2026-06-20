const {Client,GatewayIntentBits,PermissionFlagsBits}=require('discord.js');
const cron=require('node-cron');
const Sleeper=require('./sleeper'),State=require('./state');
const {buildRulesEmbeds}=require('./rules');
const {postVotes}=require('./votes');
const {slugName,formatRosterEmbed,formatRosterDiff,formatTradeEmbed,formatStandingsEmbed,formatMaxPFEmbed}=require('./formatters');
require('dotenv').config();

const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildMessageReactions]});
function findCh(guild,name){return guild.channels.cache.find(c=>c.type===0&&c.name===name)||null}
async function clearPin(ch,embeds){try{const m=await ch.messages.fetch({limit:50});if(m.size)await ch.bulkDelete(m).catch(()=>{})}catch{}for(let i=0;i<embeds.length;i+=10){const msg=await ch.send({embeds:embeds.slice(i,i+10)});if(i===0)await msg.pin().catch(()=>{})}}

client.once('ready',async()=>{
  console.log('\n✅ Doug Da Dynasty Bot is online');
  const guild=client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if(!guild){console.error('❌ Guild not found');process.exit(1)}
  await setup(guild);
  await poll(guild);
  setInterval(()=>poll(guild),60000);
  cron.schedule('0 9 * * 2',async()=>{console.log('📰 Tuesday 9AM firing...');await postStandings(guild);await postMaxPF(guild)},{timezone:'America/New_York'});
  console.log('⏰ Scheduled: standings + Max PF every Tuesday 9 AM ET\n');
});

async function setup(guild){
  console.log('🔧 Running setup...');
  const id=process.env.SLEEPER_LEAGUE_ID;
  const [league,rosters,users,nfl]=await Promise.all([Sleeper.getLeague(id),Sleeper.getRosters(id),Sleeper.getUsers(id),Sleeper.getNFLState()]);
  State.set('nflWeek',nfl.week);
  const um={};users.forEach(u=>{um[u.user_id]=u});State.set('userMap',um);
  const rum={};rosters.forEach(r=>{rum[r.roster_id]=um[r.owner_id]||{display_name:`Team ${r.roster_id}`,user_id:r.owner_id}});State.set('rosterUserMap',rum);
  if(!State.get('seenTransactions')){const tx=await Sleeper.getTransactions(id,nfl.week);const seen={};tx.forEach(t=>{seen[t.transaction_id]=true});State.set('seenTransactions',seen);console.log(`📌 Seeded ${Object.keys(seen).length} transactions`)}
  if(!State.get('channelsCreated')){
    await createChannels(guild,rosters,rum,league);
    await postRules(guild);await postVotesChannel(guild);await seedRosters(guild,rosters,rum);
    State.set('channelsCreated',true);
    const snap={};rosters.forEach(r=>{snap[r.roster_id]=r.players||[]});State.set('rosterSnapshot',snap);
  } else {
    await updateRosterNames(guild,rosters,rum);
  }
  console.log('✅ Setup complete\n');
}

async function createChannels(guild,rosters,rum,league){
  console.log('📢 Creating channels...');
  const pub=await guild.channels.create({name:`🏈 ${league.name}`,type:4});
  for(const[n,t]of[['📜rules','League rules and official settings'],['trade-alerts','Every completed Sleeper trade — react to weigh in'],['league-settings-options','League setting proposals and votes'],['standings','Weekly standings — updated every Tuesday 9 AM'],['max-points-tracker','Max PF standings — determines rookie draft order']]){
    await guild.channels.create({name:n,type:0,parent:pub.id,topic:t});console.log(`  ✓ #${n}`);}
  const priv=await guild.channels.create({name:'🔒 Team Rosters',type:4});
  const cm={};
  for(const r of rosters){const u=rum[r.roster_id],name=slugName(u);const ch=await guild.channels.create({name,type:0,parent:priv.id,topic:`Roster log for ${u.display_name}`,permissionOverwrites:[{id:guild.id,deny:[PermissionFlagsBits.ViewChannel]}]});cm[r.roster_id]=ch.id;console.log(`  ✓ #${name}`)}
  State.set('rosterChannelMap',cm);
}

async function postRules(guild){const ch=findCh(guild,'📜rules');if(!ch)return;await clearPin(ch,buildRulesEmbeds());console.log('📜 Rules posted')}
async function postVotesChannel(guild){const ch=findCh(guild,'league-settings-options');if(!ch)return;try{const m=await ch.messages.fetch({limit:50});if(m.size)await ch.bulkDelete(m).catch(()=>{})}catch{}await postVotes(ch);console.log('🗳️ Votes posted')}

async function seedRosters(guild,rosters,rum){
  console.log('📋 Seeding roster channels...');
  const players=await Sleeper.getAllPlayers(),cm=State.get('rosterChannelMap')||{};
  for(const r of rosters){const u=rum[r.roster_id],chId=cm[r.roster_id],ch=chId?guild.channels.cache.get(chId):guild.channels.cache.find(c=>c.name===slugName(u));if(!ch)continue;const msg=await ch.send({embeds:[formatRosterEmbed(r,u,players)]});await msg.pin().catch(()=>{});console.log(`  ✓ ${u.display_name}`)}
}

async function updateRosterNames(guild,rosters,rum){
  const cm=State.get('rosterChannelMap')||{};
  for(const r of rosters){const u=rum[r.roster_id],exp=slugName(u),chId=cm[r.roster_id];if(!chId)continue;const ch=guild.channels.cache.get(chId);if(!ch||ch.name===exp)continue;await ch.setName(exp).catch(()=>{});console.log(`  ✏️ Renamed → #${exp}`)}
}

async function poll(guild){
  try{const id=process.env.SLEEPER_LEAGUE_ID,week=State.get('nflWeek');await pollTransactions(guild,id,week);await pollRosterChanges(guild,id)}
  catch(err){console.error('❌ Poll:',err.message)}
}

async function pollTransactions(guild,id,week){
  const all=await Sleeper.getTransactions(id,week);const seen=State.get('seenTransactions')||{};
  const fresh=all.filter(t=>!seen[t.transaction_id]);if(!fresh.length)return;
  const players=await Sleeper.getAllPlayers(),rum=State.get('rosterUserMap');
  const ch=findCh(guild,'trade-alerts');
  for(const tx of fresh){seen[tx.transaction_id]=true;if(tx.type==='trade'&&tx.status==='complete'){if(ch){const msg=await ch.send({embeds:[formatTradeEmbed(tx,rum,players)]});await msg.react('✅').catch(()=>{});await msg.react('❌').catch(()=>{});await msg.react('🤷').catch(()=>{});console.log(`🔄 Trade posted TX ${tx.transaction_id}`)}}}
  State.set('seenTransactions',seen);
}

async function pollRosterChanges(guild,id){
  const rosters=await Sleeper.getRosters(id),snap=State.get('rosterSnapshot')||{},rum=State.get('rosterUserMap');
  const players=await Sleeper.getAllPlayers(),cm=State.get('rosterChannelMap')||{};let changed=false;
  for(const r of rosters){const prev=snap[r.roster_id]||[],curr=r.players||[];const added=curr.filter(p=>!prev.includes(p)),dropped=prev.filter(p=>!curr.includes(p));if(!added.length&&!dropped.length)continue;
  const u=rum[r.roster_id],chId=cm[r.roster_id],ch=chId?guild.channels.cache.get(chId):guild.channels.cache.find(c=>c.name===slugName(u));
  if(ch){await ch.send({embeds:[formatRosterDiff(u,added,dropped,players)]});console.log(`📝 Roster move: ${u.display_name}`)}
  snap[r.roster_id]=curr;changed=true;}
  if(changed)State.set('rosterSnapshot',snap);
}

async function postStandings(guild){
  try{const id=process.env.SLEEPER_LEAGUE_ID,week=State.get('nflWeek');const[rosters,users,matchups,next]=await Promise.all([Sleeper.getRosters(id),Sleeper.getUsers(id),Sleeper.getMatchups(id,week).catch(()=>[]),Sleeper.getMatchups(id,week+1).catch(()=>[])]);const um={};users.forEach(u=>{um[u.user_id]=u});const ch=findCh(guild,'standings');if(!ch)return;await ch.send({embeds:[formatStandingsEmbed(rosters,um,matchups,next,week)]});console.log(`📰 Standings week ${week}`)}
  catch(err){console.error('❌ Standings:',err.message)}
}

async function postMaxPF(guild){
  try{const id=process.env.SLEEPER_LEAGUE_ID,week=State.get('nflWeek');const[rosters,users]=await Promise.all([Sleeper.getRosters(id),Sleeper.getUsers(id)]);const um={};users.forEach(u=>{um[u.user_id]=u});const ch=findCh(guild,'max-points-tracker');if(!ch)return;await ch.send({embeds:[formatMaxPFEmbed(rosters,um,week)]});console.log(`💥 Max PF week ${week}`)}
  catch(err){console.error('❌ MaxPF:',err.message)}
}

client.login(process.env.DISCORD_BOT_TOKEN);
