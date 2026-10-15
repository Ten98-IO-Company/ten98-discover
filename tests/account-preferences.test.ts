import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountLocaleInventory,accountLocales,accountLocaleMapping,accountPreferencesDefaults,accountPreferencesDtoSchema,accountPreferencesWireDtoSchema,accountPreferencesWireInputSchema,accountPreferencesInputSchema,canonicalAccountTimeZone} from '../src/lib/account-preferences.ts';

const valid={expectedRevision:0,name:'Member',timeZone:'UTC',locale:'en-US',theme:'light'};
test('the exact54-locale baseline preserves four RTL choices without claiming translated UI',()=>{
  assert.equal(accountLocales.length,54);assert.equal(new Set(accountLocales).size,54);
  assert.deepEqual(accountLocaleInventory.filter(([, ,direction])=>direction==='rtl').map(([code])=>code),['ar-SA','fa-IR','he-IL','ur-PK']);
  assert.deepEqual(accountLocaleMapping('ga-ES'),{code:'ga-ES',label:'Galician (Spain)',direction:'ltr',formatLocale:'gl-ES'});
  assert.equal(accountLocaleMapping('ur-PK').formatLocale,'ur-PK');assert.equal(accountLocaleMapping('si-LK').formatLocale,'si-LK');
  assert.deepEqual(accountPreferencesDefaults,{timeZone:'UTC',locale:'en-US',theme:'light'});
});
test('display names and time zones are normalized with bounded Unicode input',()=>{
  assert.equal(accountPreferencesInputSchema.parse({...valid,name:'  أمينة  '}).name,'أمينة');
  assert.equal(accountPreferencesInputSchema.parse({...valid,name:'Member 🧭'}).name,'Member 🧭');
  assert.equal(accountPreferencesInputSchema.parse({...valid,timeZone:'Etc/UTC'}).timeZone,'UTC');
  assert.equal(canonicalAccountTimeZone('Asia/Dubai'),'Asia/Dubai');
  for(const name of['',' \n ','member\u0000secret','a\nb','\ud800','a'.repeat(121)])assert.equal(accountPreferencesInputSchema.safeParse({...valid,name}).success,false);
  for(const timeZone of['',' UTC','UTC\n','+04:00','../../etc/passwd','Unknown/Nowhere','A'.repeat(81)])assert.equal(accountPreferencesInputSchema.safeParse({...valid,timeZone}).success,false);
});
test('the preference boundary cannot change identity, workspace, security or unregistered settings',()=>{
  for(const field of['userId','workspaceId','email','password','role','image','twoFactorEnabled','preferences','__proto__']){
    const body=JSON.parse(JSON.stringify(valid).replace(/}$/,`,"${field}":"untrusted"}`));assert.equal(accountPreferencesInputSchema.safeParse(body).success,false);
  }
  for(const patch of[{locale:'xx-XX'},{locale:'gl-ES'},{locale:'en-US-u-ca-islamic'},{theme:'auto'},{theme:'LIGHT'},{expectedRevision:-1},{expectedRevision:0.5},{expectedRevision:2147483648}])assert.equal(accountPreferencesInputSchema.safeParse({...valid,...patch}).success,false);
  for(const theme of['light','dark','system'])assert.equal(accountPreferencesInputSchema.safeParse({...valid,theme}).success,true);
});
test('saved DTOs separate absent defaults from committed revision and never normalize bad server state',()=>{
  const dto={version:'account-preferences-v1',user:{id:'member-id',name:'Member',email:'member@example.test'},preferences:{...accountPreferencesDefaults,revision:0,updatedAt:null}};
  assert.equal(accountPreferencesDtoSchema.safeParse(dto).success,true);
  assert.equal(accountPreferencesDtoSchema.safeParse({...dto,preferences:{...dto.preferences,revision:1,updatedAt:'2026-10-16T00:00:00.000Z'}}).success,true);
  for(const patch of[{revision:1},{updatedAt:'2026-10-16T00:00:00.000Z'},{timeZone:'Unknown/Nowhere'},{theme:'auto'},{locale:'xx-XX'}])assert.equal(accountPreferencesDtoSchema.safeParse({...dto,preferences:{...dto.preferences,...patch}}).success,false);
  assert.equal(accountPreferencesDtoSchema.parse({...dto,preferences:{...dto.preferences,timeZone:'Etc/UTC'}}).preferences.timeZone,'Etc/UTC');
  assert.equal(accountPreferencesDtoSchema.safeParse({...dto,session:{token:'never'}}).success,false);
});

test('wire time zones survive simulated alternate runtime canonicalization without weakening server storage',()=>{
  // This simulates two Intl datasets; it is not an installed Node/Edge compatibility measurement.
  const original=Intl.DateTimeFormat;
  const dto={version:'account-preferences-v1',user:{id:'member-id',name:'Member',email:'member@example.test'},preferences:{revision:1,timeZone:'Europe/Kiev',locale:'en-US',theme:'light',updatedAt:'2026-10-16T00:00:00.000Z'}};
  let calls=0;
  function simulated(canonical:string){return new Proxy(original,{construct(target,args){calls++;const formatter=Reflect.construct(target,args) as Intl.DateTimeFormat,options=formatter.resolvedOptions();formatter.resolvedOptions=()=>({...options,timeZone:canonical});return formatter;}});}
  try{
    Intl.DateTimeFormat=simulated('Europe/Kiev');assert.deepEqual(accountPreferencesDtoSchema.parse(dto),dto);
    Intl.DateTimeFormat=simulated('Europe/Kyiv');assert.equal(canonicalAccountTimeZone(dto.preferences.timeZone),'Europe/Kyiv');
    assert.deepEqual(accountPreferencesDtoSchema.parse(dto),dto,'A stored recognized alias must survive primary-name promotion unchanged.');
    assert.equal(accountPreferencesInputSchema.parse({...valid,timeZone:dto.preferences.timeZone}).timeZone,'Europe/Kyiv','Only explicit input canonicalizes the old name to the new primary.');
    const before=calls,parsed=accountPreferencesWireDtoSchema.parse(dto);assert.equal(calls,before,'Wire validation must not consult the client Intl dataset.');
    assert.deepEqual(parsed,dto);assert.equal(parsed.preferences.timeZone,'Europe/Kiev');
    const wireInput={...valid,timeZone:dto.preferences.timeZone},beforeInput=calls;
    assert.deepEqual(accountPreferencesWireInputSchema.parse(wireInput),wireInput);
    assert.deepEqual(accountPreferencesWireInputSchema.parse({...wireInput,timeZone:'Future/Region'}),{...wireInput,timeZone:'Future/Region'},'Wire input delegates named-zone recognition to the server, not the client dataset.');
    assert.equal(calls,beforeInput,'Wire input must not consult the client Intl dataset.');
    for(const timeZone of ['+04:00',' UTC','UTC\n','Europe/\u0000Kyiv','../../etc/passwd','A'.repeat(81)])assert.equal(accountPreferencesWireInputSchema.safeParse({...wireInput,timeZone}).success,false);
    for(const patch of [{expectedRevision:-1},{expectedRevision:0.5},{expectedRevision:2147483648},{name:''},{name:'bad\nname'},{name:'a'.repeat(121)},{locale:'xx-XX'},{theme:'automatic'},{userId:'another-user'}])assert.equal(accountPreferencesWireInputSchema.safeParse({...wireInput,...patch}).success,false);
    for(const timeZone of ['+04:00',' UTC','UTC\n','Europe/\u0000Kyiv','../../etc/passwd','A'.repeat(81)])assert.equal(accountPreferencesWireDtoSchema.safeParse({...dto,preferences:{...dto.preferences,timeZone}}).success,false);
    for(const patch of [{revision:0},{revision:-1},{revision:2147483648},{updatedAt:null},{theme:'automatic'},{locale:'xx-XX'}])assert.equal(accountPreferencesWireDtoSchema.safeParse({...dto,preferences:{...dto.preferences,...patch}}).success,false);
    assert.equal(accountPreferencesWireDtoSchema.safeParse({...dto,session:{token:'never'}}).success,false);
    assert.equal(accountPreferencesWireDtoSchema.safeParse({...dto,preferences:{...dto.preferences,extra:true}}).success,false);
    assert.equal(accountPreferencesWireDtoSchema.safeParse({...dto,user:{...dto.user,role:'owner'}}).success,false);
  }finally{Intl.DateTimeFormat=original;}
});
