import { AuthUser, UserProfile, DiscoverProfile, MatchItem, MessageItem, BlockRecord, UserSettings, DiscoverFilters } from '../types.js';
const TOKEN_KEY='flatmate_plus_token';
export function getStoredToken():string|null{return localStorage.getItem(TOKEN_KEY);} export function setStoredToken(token:string){localStorage.setItem(TOKEN_KEY,token);} export function clearStoredToken(){localStorage.removeItem(TOKEN_KEY);}
async function request<T>(endpoint:string,options:RequestInit={},retryEmptyResponse=false):Promise<T>{
 const token=getStoredToken();
 const headers:Record<string,string>={'Content-Type':'application/json',...(options.headers as Record<string,string>||{})};
 if(token)headers.Authorization='Bearer '+token;
 try{
   const res=await fetch(endpoint,{...options,headers});
   const raw=await res.text();
   if(!raw.trim()){
     if(retryEmptyResponse){
       await new Promise(resolve=>setTimeout(resolve,700));
       const retry=await fetch(endpoint,{...options,headers});
       const retryRaw=await retry.text();
       if(!retryRaw.trim()) throw new Error('Verification server returned an empty response (HTTP '+retry.status+'). Please try the live check again.');
       let retryData:any;
       try{retryData=JSON.parse(retryRaw);}catch{throw new Error('Verification server returned an invalid response (HTTP '+retry.status+'). Please try again.');}
       if(!retry.ok)throw new Error(retryData?.error||retryData?.message||('Verification failed (HTTP '+retry.status+').'));
       return retryData as T;
     }
     throw new Error('Server returned an empty response (HTTP '+res.status+'). Please try again.');
   }
   let data:any;
   try{data=JSON.parse(raw);}catch{throw new Error('Server returned an invalid response (HTTP '+res.status+'). Please try again.');}
   if(!res.ok)throw new Error(data?.error||data?.message||('Request failed (HTTP '+res.status+').'));
   return data as T;
 }catch(err:any){
   if(err.message?.includes('Failed to fetch'))throw new Error("Couldn't reach the server. Please check your internet connection.");
   throw err;
 }}
export async function compressImageDataUrl(dataUrl:string,maxDimension=1600,quality=.78,outputMime:'image/webp'|'image/jpeg'='image/webp'):Promise<string>{if(!dataUrl?.startsWith('data:image/'))return dataUrl;return new Promise(resolve=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,maxDimension/Math.max(img.naturalWidth,img.naturalHeight));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=c.getContext('2d');if(!ctx){resolve(dataUrl);return;}ctx.drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL(outputMime,quality));};img.onerror=()=>resolve(dataUrl);img.src=dataUrl;});}
function addLivenessChallenge(dataUrl:string,challenge?:string){if(!challenge||!dataUrl.startsWith('data:'))return dataUrl;return dataUrl.replace(/^data:([^;]+);base64,/,`data:$1;challenge=${challenge};base64,`);}
export const api={
 async signup(payload:{email:string;password:string;name?:string}):Promise<{token:string;user:AuthUser}>{const r=await request<{token:string;user:AuthUser}>('/api/auth/signup',{method:'POST',body:JSON.stringify(payload)});if(r.token)setStoredToken(r.token);return r;},
 async login(payload:{email:string;password:string}):Promise<{token:string;user:AuthUser}>{const r=await request<{token:string;user:AuthUser}>('/api/auth/login',{method:'POST',body:JSON.stringify(payload)});if(r.token)setStoredToken(r.token);return r;},
 async googleAuth(payload:{id_token:string}):Promise<{token:string;user:AuthUser}>{const r=await request<{token:string;user:AuthUser}>('/api/auth/google',{method:'POST',body:JSON.stringify(payload)});if(r.token)setStoredToken(r.token);return r;},
 async sendOtp(phone:string):Promise<{success:boolean;message:string;dev_code?:string}>{return request('/api/auth/send-otp',{method:'POST',body:JSON.stringify({phone})});},
 async verifyOtp(phone:string,otp:string):Promise<{success:boolean;phone_verified:boolean;message:string}>{return request('/api/auth/verify-otp',{method:'POST',body:JSON.stringify({phone,otp})});},
 async getMe():Promise<{user:AuthUser;settings:UserSettings}>{return request('/api/auth/me');},
 async deleteAccount(confirmation:string):Promise<{success:boolean;message:string}>{const r=await request<{success:boolean;message:string}>('/api/auth/delete-account',{method:'DELETE',body:JSON.stringify({confirmation})});clearStoredToken();return r;},
 async startVerificationSession():Promise<{success:boolean;session_id:string;challenge:string;expires_at:number}>{return request('/api/verify/session',{method:'POST'});},
 async verifyLiveness(payload:{session_id:string;challenge:string;frames:string[]}):Promise<{success:boolean;passed:boolean;confidence:number;message:string;frames_analyzed?:number;valid_face_frames?:number}>{
   const frames=await Promise.all(payload.frames.map(frame=>compressImageDataUrl(frame,640,.72,'image/jpeg')));
   return request('/api/verify/liveness',{method:'POST',body:JSON.stringify({...payload,frames})},true);
 },
 async verifyFaceMatch(payload:{session_id:string;profile_photo_base64:string}):Promise<{success:boolean;passed:boolean;similarity_percentage:number;is_ai_generated:boolean;feedback:string;distance?:number;threshold?:number}>{
   const profile=await compressImageDataUrl(payload.profile_photo_base64,1280,.82,'image/jpeg');
   return request('/api/verify/face-match',{method:'POST',body:JSON.stringify({...payload,profile_photo_base64:profile})});
 },
 async updateIntent(intent:{has_house:boolean;looking_to_co_search:boolean;looking_for_vacancy:boolean}):Promise<{profile:UserProfile}>{return request('/api/profile/intent',{method:'PUT',body:JSON.stringify(intent)});},
 async updateProfile(updates:Partial<UserProfile>):Promise<{profile:UserProfile}>{return request('/api/profile',{method:'PUT',body:JSON.stringify(updates)});},
 async uploadPhoto(payload:{photo_base64:string;mime_type:string;caption?:string;is_main?:boolean;verification_session_id?:string}):Promise<{success:boolean;photo:any;profile:UserProfile}>{const compressed=payload.verification_session_id?await compressImageDataUrl(payload.photo_base64,1280,.82,'image/jpeg'):await compressImageDataUrl(payload.photo_base64,1600,.78);return request('/api/profile/upload-photo',{method:'POST',body:JSON.stringify({...payload,photo_base64:compressed,mime_type:payload.verification_session_id?'image/jpeg':'image/webp'})});},
 async uploadHousePhoto(payload:{photo_base64:string;mime_type:string;caption?:string}):Promise<{success:boolean;photo:any;house_details:any;profile:UserProfile}>{const compressed=await compressImageDataUrl(payload.photo_base64,1600,.78);return request('/api/profile/upload-house-photo',{method:'POST',body:JSON.stringify({...payload,photo_base64:compressed,mime_type:'image/webp'})});},
 async reactivateDiscover():Promise<{success:boolean;profile:UserProfile}>{return request('/api/profile/reactivate-discover',{method:'POST'});},
 async getDiscoverProfiles(filters?:DiscoverFilters):Promise<{profiles:DiscoverProfile[];total:number;timestamp:number}>{const params=new URLSearchParams();if(filters)Object.entries(filters).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!==''){if(Array.isArray(v)){if(v.length)params.append(k,v.join(','));}else params.append(k,String(v));}});const query=params.toString()?`?${params}`:'';return request(`/api/discover${query}`);},
 async swipe(target_user_id:string,action:'like'|'pass'):Promise<{success:boolean;is_match:boolean;match?:MatchItem}>{return request('/api/discover/swipe',{method:'POST',body:JSON.stringify({target_user_id,action})});},
 async getPassedProfiles():Promise<{profiles:DiscoverProfile[];total:number}>{return request('/api/discover/passed');},async undoPass(target_user_id:string):Promise<{success:boolean}>{return request('/api/discover/undo-pass',{method:'POST',body:JSON.stringify({target_user_id})});},
 async getMatches():Promise<{matches:MatchItem[]}>{return request('/api/matches');},async getMatchDetail(matchId:string):Promise<{match:MatchItem;messages:MessageItem[]}>{return request(`/api/matches/${matchId}`);},async sendMessage(matchId:string,content:string):Promise<{message:MessageItem}>{return request(`/api/matches/${matchId}/messages`,{method:'POST',body:JSON.stringify({content})});},async markMessagesRead(matchId:string):Promise<{success:boolean}>{return request(`/api/matches/${matchId}/read`,{method:'POST'});},async requestMovingIn(matchId:string):Promise<{success:boolean;both_confirmed:boolean;match:MatchItem;message:string}>{return request(`/api/matches/${matchId}/moving-in`,{method:'POST'});},
 async blockUser(target_user_id:string,reason?:string):Promise<{success:boolean;message:string}>{return request('/api/users/block',{method:'POST',body:JSON.stringify({target_user_id,reason})});},async reportUser(target_user_id:string,reason:string,details?:string):Promise<{success:boolean;message:string}>{return request('/api/users/report',{method:'POST',body:JSON.stringify({target_user_id,reason,details})});},async getBlockedUsers():Promise<{blocked_users:BlockRecord[]}>{return request('/api/users/blocked');},async unblockUser(target_user_id:string):Promise<{success:boolean;message:string}>{return request('/api/users/unblock',{method:'POST',body:JSON.stringify({target_user_id})});},async getSettings():Promise<{settings:UserSettings}>{return request('/api/settings');},async updateSettings(settings:Partial<UserSettings>):Promise<{settings:UserSettings}>{return request('/api/settings',{method:'PUT',body:JSON.stringify(settings)});}
};
