const fs=require('fs'),path=require('path'),F=path.join(__dirname,'state.json');
let _s={};
if(fs.existsSync(F)){try{_s=JSON.parse(fs.readFileSync(F,'utf8'));console.log('📂 State loaded')}catch{_s={}}}
const K=['channelsCreated','seenTransactions','lastChatId','rosterSnapshot','nflWeek','powerRankLastWeek','standingsMessageIds','rosterChannelMap'];
function save(){const o={};K.forEach(k=>{if(_s[k]!==undefined)o[k]=_s[k]});fs.writeFileSync(F,JSON.stringify(o,null,2))}
module.exports={get:k=>_s[k],set:(k,v)=>{_s[k]=v;save()}};
