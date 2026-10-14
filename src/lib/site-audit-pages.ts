export const auditPageSearchIn=['url_title_meta','url'] as const;
export const auditPageSort=['url','httpStatus','title','h1','wordCount','images','responseTimeMs'] as const;
export const auditPageOrder=['asc','desc'] as const;
export type AuditPageFields={search:string;searchIn:typeof auditPageSearchIn[number];sort:typeof auditPageSort[number];order:typeof auditPageOrder[number]};

/** Shared URL/API fields only; invalid input never broadens to an unfiltered report. */
export function normalizeAuditPageFields(raw:unknown):AuditPageFields|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const fields=raw as Record<string,unknown>;
 if(Object.keys(fields).some(key=>!['search','searchIn','sort','order'].includes(key)))return null;
 const search=fields.search===undefined?'':fields.search;
 if(typeof search!=='string'||/[\p{Cc}\p{Cs}]/u.test(search))return null;
 const normalized=search.trim();
 if(Array.from(normalized).length>200||new TextEncoder().encode(normalized).length>800)return null;
 const searchIn=fields.searchIn===undefined?'url_title_meta':fields.searchIn,sort=fields.sort===undefined?'url':fields.sort,order=fields.order===undefined?'asc':fields.order;
 if(!auditPageSearchIn.includes(searchIn as AuditPageFields['searchIn'])||!auditPageSort.includes(sort as AuditPageFields['sort'])||!auditPageOrder.includes(order as AuditPageFields['order']))return null;
 return {search:normalized,searchIn:searchIn as AuditPageFields['searchIn'],sort:sort as AuditPageFields['sort'],order:order as AuditPageFields['order']};
}
