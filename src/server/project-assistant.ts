import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {contentCursor,contentReceipt,readContentCursor,withContentProject} from './project-context.ts';

const revisionSchema=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const receiptSchema=z.object({conversationId:z.uuid(),revision:revisionSchema,eventId:z.uuid().optional()}).strict();
const appendSchema=z.object({conversationId:z.uuid(),requestId:z.uuid(),expectedRevision:revisionSchema,text:z.string().min(1).max(131072)}).strict();
function revision(value:unknown):number {
 if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))throw new FoundationError(503,'Stored conversation revision is invalid.');
 const parsed=revisionSchema.safeParse(Number(value));
 if(!parsed.success)throw new FoundationError(503,'Stored conversation revision is invalid.');
 return parsed.data;
}

export async function createAssistantConversation(projectId:string,userId:string,requestId:string){
 parse(z.uuid(),requestId);
 return withContentProject(projectId,userId,true,async(client,project)=>{
  const receipt=await contentReceipt(client,project.id,requestId,'assistant.conversation.create.v1',{userId});
  if(receipt.replayed)return {...parse(receiptSchema,receipt.result),replayed:true};
  const conversationId=randomUUID();
  await client.query('INSERT INTO assistant_conversation(id,project_id,created_by)VALUES($1,$2,$3)',[conversationId,project.id,userId]);
  const result={conversationId,revision:0};await receipt.save(result);return {...result,replayed:false};
 },undefined,true);
}

export async function listAssistantConversations(projectId:string,userId:string,cursor:string|null=null){
 const scope={projectId,list:'assistant-conversations-v1'},after=readContentCursor(cursor,scope);
 return withContentProject(projectId,userId,false,async(client,project)=>{
  const rows=(await client.query<{id:string;createdAt:Date;revision:string}>(`SELECT id,created_at AS "createdAt",revision FROM assistant_conversation
   WHERE project_id=$1 AND($2::timestamptz IS NULL OR(created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`,[project.id,after?.at??null,after?.id??null])).rows;
  return {conversations:rows.slice(0,20).map(row=>({id:row.id,createdAt:row.createdAt.toISOString(),revision:revision(row.revision)})),nextCursor:rows.length>20?contentCursor(rows[19],scope):null};
 },undefined,true);
}

export async function getAssistantConversation(projectId:string,userId:string,conversationId:string,afterSequence=0){
 parse(z.uuid(),conversationId);parse(revisionSchema,afterSequence);
 return withContentProject(projectId,userId,false,async(client,project)=>{
  const found=(await client.query('SELECT revision FROM assistant_conversation WHERE project_id=$1 AND id=$2',[project.id,conversationId])).rows[0];
  if(!found)throw new FoundationError(404,'Conversation not found.');
  const rows=(await client.query<{id:string;sequence:string;createdAt:Date;authorId:string;text:string|null;expired:boolean;payloadPresent:boolean}>(`SELECT e.id,e.sequence,e.created_at AS "createdAt",e.actor_id AS "authorId",b.event_id IS NOT NULL AS "payloadPresent",
    e.created_at<GREATEST(p.assistant_payload_retained_from,statement_timestamp()-w.derived_history_days*interval '24 hours') AS expired,
    CASE WHEN e.created_at<GREATEST(p.assistant_payload_retained_from,statement_timestamp()-w.derived_history_days*interval '24 hours') THEN NULL ELSE b.exact_text END AS text
    FROM assistant_event e JOIN project p ON p.id=e.project_id JOIN workspace w ON w.id=p.workspace_id
    LEFT JOIN assistant_event_payload b ON b.project_id=e.project_id AND b.event_id=e.id
    WHERE e.project_id=$1 AND e.conversation_id=$2 AND e.sequence>$3 ORDER BY e.sequence LIMIT 101`,[project.id,conversationId,afterSequence])).rows;
  const events=rows.slice(0,100).map(row=>({id:row.id,sequence:revision(row.sequence),createdAt:row.createdAt.toISOString(),authorId:row.authorId,
   availability:!row.payloadPresent?'purged' as const:row.expired?'expired' as const:'available' as const,text:row.text}));
  return {conversationId,revision:revision(found.revision),events,nextSequence:rows.length>100?events[99].sequence:null};
 },undefined,true);
}

export async function appendAssistantUserTurn(projectId:string,userId:string,raw:unknown){
 const input=parse(appendSchema,raw),bytes=Buffer.byteLength(input.text,'utf8');
 if(bytes>131072||input.text.includes('\0')||Buffer.from(input.text,'utf8').toString('utf8')!==input.text)throw new FoundationError(400,'Use valid text within the conversation size limit.');
 return withContentProject(projectId,userId,true,async(client,project)=>{
  const receipt=await contentReceipt(client,project.id,input.requestId,'assistant.user.append.v1',{userId,...input});
  if(receipt.replayed)return {...parse(receiptSchema.extend({eventId:z.uuid()}),receipt.result),replayed:true};
  const found=(await client.query('SELECT revision FROM assistant_conversation WHERE project_id=$1 AND id=$2 FOR UPDATE',[project.id,input.conversationId])).rows[0];
  if(!found)throw new FoundationError(404,'Conversation not found.');
  const current=revision(found.revision);
  if(current!==input.expectedRevision||current===Number.MAX_SAFE_INTEGER)throw new FoundationError(409,'Conversation changed. Reload before adding a message.');
  const next=current+1,eventId=randomUUID();
  await client.query('INSERT INTO assistant_event(id,project_id,conversation_id,sequence,actor_id,payload_sha256,payload_bytes)VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,project.id,input.conversationId,next,userId,createHash('sha256').update(input.text,'utf8').digest('hex'),bytes]);
  await client.query('INSERT INTO assistant_event_payload(event_id,project_id,exact_text)VALUES($1,$2,$3)',[eventId,project.id,input.text]);
  const updated=await client.query('UPDATE assistant_conversation SET revision=$3 WHERE project_id=$1 AND id=$2 AND revision=$4',[project.id,input.conversationId,next,current]);
  if(updated.rowCount!==1)throw new FoundationError(409,'Conversation changed. Reload before adding a message.');
  const result={conversationId:input.conversationId,eventId,revision:next};await receipt.save(result);return {...result,replayed:false};
 },undefined,true);
}
