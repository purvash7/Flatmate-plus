import * as faceapi from '@vladmandic/face-api';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';

export type LocalChallenge='thumbs_up'|'thumbs_down'|'peace'|'open_hand'|'pointing_up'|'ilove_you';
export interface LocalLivenessResult{passed:boolean;confidence:number;message:string;faceCount:number;framesAnalyzed:number;gesture?:LocalChallenge;}
export interface LocalFaceMatchResult{passed:boolean;similarity_percentage:number;confidence:number;feedback:string;}

const FACE_MODEL_URL='https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
const VISION_WASM_URL='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const GESTURE_MODEL_URL='https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

let gesturePromise:Promise<GestureRecognizer|null>|null=null;
let faceModelsPromise:Promise<void>|null=null;

const GESTURES:Record<LocalChallenge,{label:string;emoji:string;apiName:string}>= {
  thumbs_up:{label:'thumbs up',emoji:'👍',apiName:'Thumb_Up'},
  thumbs_down:{label:'thumbs down',emoji:'👎',apiName:'Thumb_Down'},
  peace:{label:'peace sign',emoji:'✌️',apiName:'Victory'},
  open_hand:{label:'open hand',emoji:'🖐️',apiName:'Open_Palm'},
  pointing_up:{label:'one finger pointing up',emoji:'☝️',apiName:'Pointing_Up'},
  ilove_you:{label:'I-love-you sign',emoji:'🤟',apiName:'ILoveYou'},
};

async function getGestureRecognizer(){
  if(!gesturePromise){
    gesturePromise=(async()=>{
      try{
        const vision=await FilesetResolver.forVisionTasks(VISION_WASM_URL);
        return await GestureRecognizer.createFromOptions(vision,{
          baseOptions:{modelAssetPath:GESTURE_MODEL_URL},
          runningMode:'VIDEO',
          numHands:1,
          minHandDetectionConfidence:.45,
          minHandPresenceConfidence:.45,
          minTrackingConfidence:.45
        });
      }catch(error){
        console.warn('Local gesture model unavailable; server liveness fallback will be used.',error);
        return null;
      }
    })();
  }
  return gesturePromise;
}

async function ensureFaceModels(){
  if(!faceModelsPromise){
    faceModelsPromise=Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
    ]).catch(error=>{faceModelsPromise=null;throw error;});
  }
  return faceModelsPromise;
}

export async function preloadLocalVerificationModels(){await getGestureRecognizer();}
export function getGestureChallenge(challenge:LocalChallenge){return GESTURES[challenge];}

export async function runLocalLiveness(video:HTMLVideoElement,challenge:LocalChallenge,onProgress?:(message:string)=>void,onFrame?:(frame:string)=>void):Promise<LocalLivenessResult>{
  const recognizer=await getGestureRecognizer();
  const target=GESTURES[challenge].apiName;
  const started=performance.now();
  const frames:string[]=[];
  let matchingFrames=0;
  let analyzed=0;
  let bestGestureScore=0;
  let lastTimestamp=0;

  while(performance.now()-started<4200&&frames.length<10){
    if(video.readyState>=2&&video.videoWidth&&video.videoHeight){
      analyzed++;
      let matched=false;
      if(recognizer){
        try{
          const timestamp=Math.max(Date.now(),lastTimestamp+1);
          lastTimestamp=timestamp;
          const result=recognizer.recognizeForVideo(video,timestamp);
          const top=result.gestures?.[0]?.[0];
          const score=top?.score||0;
          matched=top?.categoryName===target&&score>=.50;
          if(matched){matchingFrames++;bestGestureScore=Math.max(bestGestureScore,score);}
          onProgress?.(matched?'Gesture recognized · '+Math.round(score*100)+'%':'Show '+GESTURES[challenge].label+' while keeping your face visible');
        }catch{
          onProgress?.('Show '+GESTURES[challenge].label+' while keeping your face visible');
        }
      }else{
        onProgress?.('Show '+GESTURES[challenge].label+' while keeping your face visible');
      }

      const canvas=document.createElement('canvas');
      const maxDimension=640;
      const scale=Math.min(1,maxDimension/Math.max(video.videoWidth,video.videoHeight));
      canvas.width=Math.max(1,Math.round(video.videoWidth*scale));
      canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
      const ctx=canvas.getContext('2d');
      if(ctx){
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const frame=canvas.toDataURL('image/jpeg',.62);
        frames.push(frame);
        onFrame?.(frame);
      }
    }
    await new Promise(resolve=>setTimeout(resolve,180));
  }

  const gesturePassed=!recognizer||matchingFrames>=2;
  if(frames.length<6||!gesturePassed){
    return{
      passed:false,
      confidence:Math.round((matchingFrames/Math.max(1,frames.length))*100),
      message:recognizer
        ? 'Please show '+GESTURES[challenge].label+' clearly with one hand while keeping your face visible, then try again.'
        : 'Please keep your face visible and move naturally while showing the requested sign, then try again.',
      faceCount:0,
      framesAnalyzed:analyzed,
      gesture:challenge
    };
  }

  return{
    passed:true,
    confidence:Math.max(85,Math.round((matchingFrames/Math.max(1,frames.length))*.7*100+Math.min(1,bestGestureScore)*30)),
    message:'Live sequence captured. Verifying securely on the server…',
    faceCount:1,
    framesAnalyzed:analyzed,
    gesture:challenge
  };
}

export async function matchLocalFaces(livePhoto:string,profilePhoto:string):Promise<LocalFaceMatchResult>{
  await ensureModels();const [liveImage,profileImage]=await Promise.all([loadImage(livePhoto),loadImage(profilePhoto)]);const options=new faceapi.TinyFaceDetectorOptions({inputSize:416,scoreThreshold:.6});
  const [liveFaces,profileFaces]=await Promise.all([faceapi.detectAllFaces(liveImage,options).withFaceLandmarks().withFaceDescriptors(),faceapi.detectAllFaces(profileImage,options).withFaceLandmarks().withFaceDescriptors()]);
  if(liveFaces.length!==1||profileFaces.length!==1)return{passed:false,similarity_percentage:0,confidence:0,feedback:'Each photo must contain exactly one clear face. Please upload a front-facing photo with good lighting.'};
  if(liveFaces[0].detection.score<.65||profileFaces[0].detection.score<.65)return{passed:false,similarity_percentage:0,confidence:0,feedback:'The face is not clear enough to verify. Please use a sharper, well-lit photo.'};
  const euclidean=faceapi.euclideanDistance(liveFaces[0].descriptor,profileFaces[0].descriptor),passed=euclidean<=.55,similarity=Math.max(0,Math.min(100,Math.round(95-((euclidean-.35)/.20)*30))),confidence=Math.max(0,Math.min(100,Math.round(100-(euclidean/.7)*100)));
  return{passed,similarity_percentage:similarity,confidence,feedback:passed?'Profile photo matches the verified live face.':'The profile photo does not match the verified live face closely enough. Please upload a clear photo of yourself.'};
}
async function loadImage(src:string):Promise<HTMLImageElement>{return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Could not load image for local verification.'));image.src=src;});}
