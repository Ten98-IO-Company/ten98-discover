// Opens an application view the way a person does: sidebar section, then its tab and sub-tab, or Settings and its
// item. Browser suites use this instead of hard-coding labels, so they follow src/lib/app-sections.ts.
import {sectionOf,settingsEntry} from '../../src/lib/app-sections.ts';
import type {AppView} from '../../src/lib/navigation.ts';

export async function openView(page:any,view:AppView):Promise<void>{
  const sidebar=page.locator('.t98-shell-sidebar'),main=page.locator('main');
  const home=sectionOf(view);
  if(home){
    const tab=home.section.tabs.find(entry=>entry.view===home.tab)!;
    await sidebar.getByRole('link',{name:home.section.label,exact:true}).click();
    await main.getByRole('navigation',{name:`${home.section.label} pages`,exact:true}).waitFor();
    if(home.tab!==home.section.tabs[0].view)await main.getByRole('navigation',{name:`${home.section.label} pages`,exact:true}).getByRole('link',{name:tab.label,exact:true}).click();
    const sub=home.subTabs?.find(entry=>entry.view===view);
    if(sub&&view!==home.tab)await main.getByRole('navigation',{name:`${tab.label} views`,exact:true}).getByRole('link',{name:sub.label,exact:true}).click();
    return;
  }
  const entry=settingsEntry(view);
  if(!entry)throw new Error(`No navigation home for view ${view}`);
  // Already in Settings: choose the item directly. Otherwise open Settings and let its landing page settle first.
  if(!await settingsOpen(main)){
    await sidebar.getByRole('link',{name:'Settings',exact:true}).click();
    await settingsCurrent(main).first().waitFor({state:'attached'});
  }
  await (await settingsSections(main)).getByRole('link',{name:entry.label,exact:true}).first().click();
  await settingsCurrent(main,entry.label).first().waitFor({state:'attached'});
}

// SettingsLayout renders its "Settings sections" navigation twice: the full list, and the same list inside a closed
// <details> menu that replaces it at template widths of 52rem or less. Browser suites resolve it only through these
// helpers, so every caller works at both widths.
const settingsLabel='Settings sections';
const fullSettings=(scope:any)=>scope.locator('.t98-settings-full-nav');

/** True when a Settings page is mounted, whichever navigation form its width shows. */
export async function settingsOpen(scope:any):Promise<boolean>{
  return await fullSettings(scope).count()>0;
}

/** The current Settings link (optionally only when it is `label`), read from the full list's DOM so it is found while
 * that list is hidden and the compact menu is closed. */
export function settingsCurrent(scope:any,label?:string):any{
  const links=label?fullSettings(scope).getByRole('link',{name:label,exact:true,includeHidden:true}):fullSettings(scope).locator('a');
  return links.and(scope.locator('[aria-current="page"]'));
}

/**
 * The visible "Settings sections" navigation. When the full list is hidden, this opens the compact menu first.
 * Choosing a link closes that menu again, so resolve the navigation afresh before each use.
 */
export async function settingsSections(scope:any):Promise<any>{
  const full=fullSettings(scope).getByRole('navigation',{name:settingsLabel,exact:true});
  const compact=scope.locator('details.t98-settings-compact-nav');
  const summary=compact.locator('summary.t98-settings-compact-nav__summary');
  await full.or(summary).first().waitFor();
  if(await full.isVisible())return full;
  if(!await compact.evaluate((node:HTMLDetailsElement)=>node.open))await summary.click();
  const nav=compact.getByRole('navigation',{name:settingsLabel,exact:true});
  await nav.waitFor();
  return nav;
}
