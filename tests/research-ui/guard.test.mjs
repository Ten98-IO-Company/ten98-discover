import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';

test('research fixture refuses URL overrides and retains explicit loopback identity over PG environment defaults',async()=>{
  const saved={...process.env};
  try{
    for(const key of Object.keys(process.env))if(key.startsWith('PG'))delete process.env[key];
    const connection='postgresql://synthetic:synthetic@localhost:5432/ten98_research_ui_guard';
    Object.assign(process.env,{TEN98_INTEGRATION_TEST:'1',TEN98_RESEARCH_BROWSER:'1',PLAYWRIGHT_MODULE:'synthetic-unused-module',APP_URL:'http://localhost:3049',BASE_URL:'http://localhost:3049',DATABASE_URL:connection});
    const {fixtureGuard}=await import('./guard.mjs');
    assert.equal(fixtureGuard({manifest:false}).database,'ten98_research_ui_guard');
    for(const suffix of ['?host=outside.example.com','?hostaddr=198.18.0.1','?host=%2Ftmp','?port=5433','?sslmode=require','#fragment']){
      process.env.DATABASE_URL=connection+suffix;assert.throws(()=>fixtureGuard({manifest:false}),/overrides and fragments/);
    }
    for(const invalid of ['postgresql://outside.example.com/ten98_research_ui_guard','postgresql://localhost/other_database']){
      process.env.DATABASE_URL=invalid;assert.throws(()=>fixtureGuard({manifest:false}));
    }
    process.env.DATABASE_URL=connection;
    Object.assign(process.env,{PGHOST:'outside.example.com',PGHOSTADDR:'198.18.0.1',PGPORT:'5433',PGDATABASE:'outside_database',PGUSER:'outside_user',PGSERVICE:'synthetic-service',PGSERVICEFILE:'synthetic-service-file'});
    fixtureGuard({manifest:false});
    // pg's actual parser is inspected without opening a socket or calling connect.
    const parameters=new pg.Client({connectionString:connection}).connectionParameters;
    assert.equal(parameters.host,'localhost');assert.equal(parameters.port,5432);
    assert.equal(parameters.database,'ten98_research_ui_guard');assert.equal(parameters.user,'synthetic');
  }finally{
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
    Object.assign(process.env,saved);
  }
});
