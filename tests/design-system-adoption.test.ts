import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppBrand, AppIcon} from '@ten98/ui/app';

test('shared Discover branding preserves the noninteractive authentication identity',()=>{
 const html=renderToStaticMarkup(createElement(AppBrand,{product:'Discover'}));
 assert.equal(html,'<span class="brand"><span class="brand-mark" aria-hidden="true">98</span><span><strong>ten98<span class="brand-dot">.</span></strong><small>DISCOVER</small></span></span>');
 assert.doesNotMatch(html,/<(?:a|button)\b|\b(?:href|tabindex)=/i,'A logo must not discard an in-memory authentication capability');
});

test('shared icons retain the established geometry, sizing and unknown-name fallback',()=>{
 const icon=(name:string,size?:number)=>renderToStaticMarkup(createElement(AppIcon,{name,size}));
 const grid=icon('grid');
 assert.equal(icon('unknown-icon'),grid);
 assert.match(grid,/<svg width="19" height="19" viewBox="0 0 24 24"/);
 assert.match(grid,/stroke-width="1\.65"/);
 assert.match(grid,/aria-hidden="true"/);
 assert.match(icon('globe',24),/<svg width="24" height="24"/);
 for(const name of ['sun','users','user','shield','key','monitor','menu','agent','layers','send','calendar','target','billboard','image','globe','chart','settings','search','plus','arrow','chevron','more','check','close','refresh','link','folder','logout','pin','download','lock','money','eye']) assert.notEqual(icon(name),grid,name+' remains available');
});

test('Discover consumes package tokens, styles and visual elements without copied foundations',async()=>{
 const [tokens,styles,bridge,sharedTokens,sharedStyles]=await Promise.all([
  readFile('src/design-tokens.css','utf8'),readFile('src/campaign-ui.css','utf8'),readFile('src/components/CampaignUI.tsx','utf8'),
  readFile(new URL(import.meta.resolve('@ten98/ui/app-tokens.css')),'utf8'),readFile(new URL(import.meta.resolve('@ten98/ui/app.css')),'utf8'),
 ]);
 assert.equal(tokens.trim(),"@import '@ten98/ui/app-tokens.css';");
 assert.match(styles,/^@import '@ten98\/ui\/app\.css';\s*@import '@ten98\/ui\/product\.css';\s*\/\* Discover adapters:/);
 assert.doesNotMatch(bridge,/<svg\b|const paths\b|brand-mark|brand-dot/,'The app must use the package visual elements');
 assert.match(bridge,/export \{ AppIcon as Icon \} from '@ten98\/ui\/app'/);
 assert.match(bridge,/<AppBrand product="Discover"\s*\/>/);
 assert.match(sharedTokens,/@import ['"]\.\/tokens\.css['"]/);
 assert.match(sharedTokens,/--color-accent:\s*var\(--t98-accent\)/);
 assert.match(sharedStyles,/\.brand-mark\s*\{/);
 assert.match(styles,/\[hidden\]\s*\{\s*display:none!important/,'Discover native hidden state remains effective');
});
