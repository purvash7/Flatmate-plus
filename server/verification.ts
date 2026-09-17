export type LivenessChallenge = 'thumbs_up' | 'thumbs_down' | 'peace' | 'open_hand';
export interface LivenessVerificationResult { passed:boolean; is_live:boolean; has_peace_sign:boolean; is_face_clear:boolean; has_gesture:boolean; challenge:LivenessChallenge; confidence:number; message:string; }
export interface FaceMatchVerificationResult { passed:boolean; similarity_percentage:number; is_same_person:boolean; is_ai_generated:boolean; confidence:number; feedback:string; }
export interface VerificationResult { verified:boolean; confidence:number; message?:string; isAiGeneratedWarning?:boolean; }

export function verifyPeaceSignLiveness(base64Data:string,_mimeType:string='image/jpeg'):LivenessVerificationResult {
  return {passed:false,is_live:false,has_peace_sign:false,is_face_clear:false,has_gesture:false,challenge:'peace',confidence:0,message:'Liveness is performed locally in the browser. Please use the live camera verification flow.'};
}

export function verifyFaceMatchAgainstLive(_livePhotoBase64:string,_profilePhotoBase64:string,_mimeType:string='image/jpeg'):FaceMatchVerificationResult {
  return {passed:false,similarity_percentage:0,is_same_person:false,is_ai_generated:false,confidence:0,feedback:'Face matching is performed locally in the browser. Please use the profile photo verification flow.'};
}

export function verifyPhotoUpload(base64Data:string,mimeType:string):VerificationResult {
  if(!base64Data)return{verified:false,confidence:0,message:'Please select or take a photo to upload.'};
  const valid=['image/jpeg','image/jpg','image/png','image/webp'];
  const n=(mimeType||'').toLowerCase();
  if(n&&!valid.some(m=>n.includes(m.split('/')[1])))return{verified:false,confidence:0,message:'Unsupported file type. Please upload a JPG, PNG, or WEBP photo.'};
  const comma=base64Data.indexOf(',');
  const len=comma>=0?base64Data.length-comma-1:base64Data.length;
  const bytes=(len*3)/4;
  if(bytes>8*1024*1024)return{verified:false,confidence:0,message:'Photo exceeds the maximum size of 8MB. Please upload a smaller image.'};
  if(bytes<1000)return{verified:false,confidence:0,message:'Image file appears incomplete or damaged. Please select a clear photo.'};
  return{verified:true,confidence:95,message:'Photo format and size verified.'};
}
