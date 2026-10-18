import {createFileRoute,useLocation} from '@tanstack/react-router';
import {SharedBoardPanel} from '../../../components/SharedBoardPanel';
export function SharedWebsiteRoute(){
 const location=useLocation();
 return <SharedBoardPanel kind="websites" path={location.pathname} search={location.searchStr} fragment={location.hash} entry={location.state.__TSR_key??location.href} historyState={location.state}/>;
}
export const Route=createFileRoute('/share/websites/$shareId')({
 head:()=>({meta:[{name:'robots',content:'noindex, nofollow'},{name:'referrer',content:'no-referrer'},{title:'Shared website · ten98 Discover'}]}),
 component:SharedWebsiteRoute,
});
