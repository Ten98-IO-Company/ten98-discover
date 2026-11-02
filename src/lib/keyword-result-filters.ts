export type KeywordResultFilters={include:string;exclude:string;intent:string;minVolume:string;maxVolume:string;minCpc:string;maxCpc:string;minDifficulty:string;maxDifficulty:string};
export type KeywordResultFilterRow={keyword:string;intent:string|null;searchVolume:number|null;cpcUsd:string|null;keywordDifficulty:number|null};
export type KeywordResultFilterErrors=Partial<Record<keyof KeywordResultFilters,string>>;
export const emptyKeywordResultFilters=():KeywordResultFilters=>({include:'',exclude:'',intent:'',minVolume:'',maxVolume:'',minCpc:'',maxCpc:'',minDifficulty:'',maxDifficulty:''});

export function filterKeywordResults<T extends KeywordResultFilterRow>(rows:T[],filters:KeywordResultFilters):{rows:T[];errors:KeywordResultFilterErrors}{
  const errors:KeywordResultFilterErrors={};
  function numberBound(key:'minVolume'|'maxVolume'|'minDifficulty'|'maxDifficulty',maximum:number,integer=false):number|null{
    const text=filters[key].trim();if(!text)return null;
    const value=Number(text);
    if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)||!Number.isFinite(value)||value<0||value>maximum||(integer&&!Number.isSafeInteger(value))){
      errors[key]=integer?'Use a whole number from 0 to 9007199254740991.':'Use a number from 0 to 100.';return null;
    }
    return value;
  }
  function cpcBound(key:'minCpc'|'maxCpc'):bigint|null{
    const text=filters[key].trim();if(!text)return null;
    if(text.length>80||!/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(text)){errors[key]='Use a non-negative USD amount with at most 6 decimal places.';return null;}
    const [whole,fraction='']=text.split('.');return BigInt(whole||'0')*1000000n+BigInt(fraction.padEnd(6,'0'));
  }
  const minVolume=numberBound('minVolume',Number.MAX_SAFE_INTEGER,true),maxVolume=numberBound('maxVolume',Number.MAX_SAFE_INTEGER,true),
    minCpc=cpcBound('minCpc'),maxCpc=cpcBound('maxCpc'),minDifficulty=numberBound('minDifficulty',100),maxDifficulty=numberBound('maxDifficulty',100);
  for(const [minimum,maximum,key]of [[minVolume,maxVolume,'maxVolume'],[minCpc,maxCpc,'maxCpc'],[minDifficulty,maxDifficulty,'maxDifficulty']] as const){
    if(minimum!==null&&maximum!==null&&minimum>maximum)errors[key]='Maximum must be at least the minimum.';
  }
  if(Object.keys(errors).length)return {rows:[],errors};
  const include=filters.include.trim().toLowerCase(),exclude=filters.exclude.trim().toLowerCase();
  const within=(value:number|null,minimum:number|null,maximum:number|null)=>(minimum===null&&maximum===null)||(value!==null&&(minimum===null||value>=minimum)&&(maximum===null||value<=maximum));
  return {errors,rows:rows.filter(row=>{
    const keyword=row.keyword.toLowerCase();
    if(include&&!keyword.includes(include)||exclude&&keyword.includes(exclude)||filters.intent&&row.intent!==filters.intent)return false;
    if(!within(row.searchVolume,minVolume,maxVolume)||!within(row.keywordDifficulty,minDifficulty,maxDifficulty))return false;
    if(minCpc!==null||maxCpc!==null){
      if(row.cpcUsd===null)return false;
      const [whole,fraction]=row.cpcUsd.split('.'),value=BigInt(whole)*1000000n+BigInt(fraction);
      if(minCpc!==null&&value<minCpc||maxCpc!==null&&value>maxCpc)return false;
    }
    return true;
  })};
}
