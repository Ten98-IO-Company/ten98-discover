import {useCallback,useRef,useState,type ReactNode} from 'react';
import {ConfirmDialog} from '@ten98/ui';

export type ConfirmRequest={title:string;description:string;confirmLabel?:string;cancelLabel?:string;danger?:boolean;confirmationText?:string;acknowledgement?:string};

// Promise adapter over the shared ConfirmDialog: the dialog only collects the decision, and callers keep running their own
// request, retry and error flows after it closes. A newer request answers any open one with false.
export function useConfirmDialog():[(request:ConfirmRequest)=>Promise<boolean>,ReactNode]{
  const [open,setOpen]=useState<ConfirmRequest|null>(null),answer=useRef<((confirmed:boolean)=>void)|null>(null);
  const settle=(confirmed:boolean)=>{const resolve=answer.current;answer.current=null;resolve?.(confirmed);};
  const confirm=useCallback((request:ConfirmRequest)=>new Promise<boolean>(resolve=>{settle(false);answer.current=resolve;setOpen(request);}),[]);
  const dialog=open&&<ConfirmDialog open title={open.title} description={open.description} confirmLabel={open.confirmLabel} cancelLabel={open.cancelLabel} danger={open.danger??true} confirmationText={open.confirmationText} acknowledgement={open.acknowledgement} onConfirm={()=>settle(true)} onOpenChange={next=>{if(!next){settle(false);setOpen(null);}}}/>;
  return [confirm,dialog];
}
