import {opportunitiesSourceDtoSchema} from '../lib/ai-opportunities-api.ts';
import {readOpportunitiesSource,type OpportunitiesSource} from './ai-opportunities-source.ts';

/** The browser receives admission identity and coverage, never copied answers or request internals. */
export function opportunitiesSourceDto(source:OpportunitiesSource){
 const {snapshot,availability,asOf,warnings}=source;
 return opportunitiesSourceDtoSchema.parse({projectId:snapshot.source.projectId,asOf,availability,expectedSource:snapshot.source,coverage:snapshot.coverage,prompts:snapshot.prompts.length,citations:snapshot.citations.length,warnings});
}
export async function getOpportunitiesSource(projectId:string,userId:string,raw:unknown,signal?:AbortSignal){
 return opportunitiesSourceDto(await readOpportunitiesSource(projectId,userId,raw,signal));
}
