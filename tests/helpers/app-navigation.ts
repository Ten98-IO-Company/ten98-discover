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
  const settings=main.getByRole('navigation',{name:'Settings sections',exact:true});
  if(!await settings.count()){
    await sidebar.getByRole('link',{name:'Settings',exact:true}).click();
    await settings.locator('a[aria-current="page"]').first().waitFor();
  }
  await settings.getByRole('link',{name:entry.label,exact:true}).first().click();
  await settings.getByRole('link',{name:entry.label,exact:true}).and(page.locator('[aria-current="page"]')).first().waitFor();
}
