// Native provisioner credentials and browser state stay in memory; the suite never persists them.
export function loadNavigationSession(options:{baseUrl:string;override?:undefined}):Promise<{
 synthetic:true;
 role:'viewer';
 externalRequests:0;
 url:string;
 storageState:{cookies:unknown[];origins:unknown[]};
}>;
