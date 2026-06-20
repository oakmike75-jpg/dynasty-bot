const B='https://api.sleeper.app/v1';
async function get(p){const r=await fetch(`${B}${p}`);if(!r.ok)throw new Error(`Sleeper ${r.status}`);return r.json()}
let _p=null;
module.exports={getLeague:id=>get(`/league/${id}`),getRosters:id=>get(`/league/${id}/rosters`),getUsers:id=>get(`/league/${id}/users`),getTransactions:(id,w)=>get(`/league/${id}/transactions/${w}`),getNFLState:()=>get('/state/nfl'),getMatchups:(id,w)=>get(`/league/${id}/matchups/${w}`),getAllPlayers:async()=>{if(_p)return _p;console.log('📥 Fetching players...');_p=await get('/players/nfl');return _p}};
