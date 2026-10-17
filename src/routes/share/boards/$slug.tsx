import {createFileRoute,useLocation} from '@tanstack/react-router';
import {SharedBoardPanel} from '../../../components/SharedBoardPanel';
export function SharedBoardRoute(){
 const location=useLocation();
 return <SharedBoardPanel path={location.pathname} search={location.searchStr} fragment={location.hash} entry={location.state.__TSR_key??location.href} historyState={location.state}/>;
}
export const Route=createFileRoute('/share/boards/$slug')({
 head:()=>({meta:[{name:'robots',content:'noindex, nofollow'},{name:'referrer',content:'no-referrer'},{title:'Shared board · ten98-monitor'}]}),
 component:SharedBoardRoute,
});