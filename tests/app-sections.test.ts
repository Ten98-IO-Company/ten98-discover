import assert from 'node:assert/strict';
import {test} from 'node:test';
import {views} from '../src/lib/navigation.ts';
import {appSections,subTabs,projectSettingsViews,sectionOf,settingsEntries,settingsEntry,standaloneViews} from '../src/lib/app-sections.ts';

test('every view keeps exactly one home, so each existing URL still opens a page',()=>{
  for(const view of views){
    const homes=[sectionOf(view)!==undefined,settingsEntry(view)!==undefined,standaloneViews.includes(view)].filter(Boolean).length;
    assert.equal(homes,1,`${view} needs exactly one home`);
  }
  const tabViews=appSections.flatMap(section=>section.tabs.map(tab=>tab.view));
  assert.equal(new Set(tabViews).size,tabViews.length,'A view is a tab of one section only.');
  assert.equal(new Set(settingsEntries.map(entry=>entry.view)).size,settingsEntries.length);
});

test('the sidebar stays short and each section page has five tabs at most',()=>{
  assert.deepEqual(appSections.map(section=>section.label),['Overview','Behaviour','Conversions','Search','AI visibility','Reports']);
  for(const section of appSections)assert.ok(section.tabs.length>=2&&section.tabs.length<=5,section.id);
});

test('modes and campaign tools select their parent tab and list it first',()=>{
  assert.deepEqual([sectionOf('compare')?.section.id,sectionOf('compare')?.tab],['overview','project']);
  assert.deepEqual([sectionOf('ai-search')?.section.id,sectionOf('ai-search')?.tab],['ai','ai-insights']);
  for(const view of ['campaigns','links','pixels'] as const)assert.deepEqual([sectionOf(view)?.section.id,sectionOf(view)?.tab],['conversions','campaigns']);
  for(const [tab,entries] of Object.entries(subTabs))assert.equal(entries![0].view,tab,'The first sub-tab is the parent tab itself.');
});

test('website setup lives in settings, not in the report sections',()=>{
  assert.deepEqual(projectSettingsViews,['installation','domains','collection','destinations','context','imports']);
  for(const view of projectSettingsViews)assert.equal(sectionOf(view),undefined);
});
