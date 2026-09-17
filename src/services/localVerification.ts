import * as faceapi from '@vladmandic/face-api';

export type LocalChallenge = 'blink' | 'turn_left' | 'turn_right' | 'smile';

export interface LocalLivenessResult { passed:boolean; confidence:number; message:string; faceCount:number; framesAnalyzed:number; }
export interface LocalFaceMatchResult { passed:boolean; similarity_percentage:number; confidence:number; feedback:string; }

const MODEL_URL='https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
let modelsPromise:Promise<void>|null=null;

function distance(a:{x:number;y:number},b:{x:number;y:number}){return Math.hypot(a.x-b.x,a.y-b.y);}
function ratio(a:{x:number;y:number},b:{x:number;y:number},c:{x:number;y:number},d:{x:number;y:number}){return(distance(a,b)+distance(c,d))/Math.max(.001,2*distance(a,d));}

async function ensureModels(){
  if(!modelsPromise){
    modelsPromise=Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]).then(()=>undefined).catch(error=>{modelsPromise=null;throw error;});
  }
  return modelsPromise;
}

export async function preloadLocalVerificationModels(){await ensureModels();}

export async function runLocalLiveness(video:HTMLVideoElement,challenge:LocalChallenge,onProgress?:(message:string)=>void):Promise<LocalLivenessResult>{
  await ensureModels();
  const options=new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:.55});
  const started=performance.now();
  const samples:Array<{yaw:number;blink:number;smile:number}>[]=[];
  let totalFrames=0;
  while(performance.now()-started<7000&&samples.length<24){
    if(video.readyState>=2){
      totalFrames++;
      const result=await faceapi.detectSingleFace(video,options).withFaceLandmarks();
      if(result){
        const p=result.landmarks.positions;
        const leftEye=p.slice(36,42),rightEye=p.slice(42,48),mouth=p.slice(48,68);
        const lc=leftEye.reduce((s,v)=>({x:s.x+v.x,y:s.y+v.y}),{x:0,y:0});
        const rc=rightEye.reduce((s,v)=>({x:s.x+v.x,y:s.y+v.y}),{x:0,y:0});
        lc.x/=leftEye.length;lc.y/=leftEye.length;rc.x/=rightEye.length;rc.y/=rightEye.length;
        const nose=p[30];const eyeMidX=(lc.x+rc.x)/2;const eyeWidth=Math.max(1,distance(lc,rc));
        const yaw=(nose.x-eyeMidX)/eyeWidth;
        const blink=(ratio(leftEye[1],leftEye[5],leftEye[2],leftEye[4])+ratio(rightEye[1],rightEye[5],rightEye[2],rightEye[4]))/2;
        const mouthWidth=Math.max(1,distance(mouth[0],mouth[6]));
        const mouthOpen=distance(mouth[3],mouth[9])/mouthWidth;
        samples.push({yaw,blink,smile:mouthOpen});
        onProgress?.(`Face detected · ${samples.length}/24 checks`);
      }
    }
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  if(samples.length<8)return{passed:false,confidence:0,message:'Keep your face centered and clearly visible, then try again.',faceCount:samples.length?1:0,framesAnalyzed:totalFrames};

  const first=samples.slice(0,5),last=samples.slice(-10);let challengeScore=0;
  if(challenge==='blink'){
    const baseline=first.reduce((s,x)=>s+x.blink,0)/first.length;
    let blinks=0,closed=false;
    for(const sample of samples){
      const isClosed=sample.blink<Math.max(.18,baseline*.58);
      if(isClosed&&!closed){blinks++;closed=true;}
      if(!isClosed)closed=false;
    }
    challengeScore=blinks>=2?1:0;
  }else if(challenge==='turn_left'){
    const base=first.reduce((s,x)=>s+x.yaw,0)/first.length;
    const min=Math.min(...last.map(x=>x.yaw));
    challengeScore=min<base-.13?1:0;
  }else if(challenge==='turn_right'){
    const base=first.reduce((s,x)=>s+x.yaw,0)/first.length;
    const max=Math.max(...last.map(x=>x.yaw));
    challengeScore=max>base+.13?1:0;
  }else{
    const neutral=first.reduce((s,x)=>s+x.smile,0)/first.length;
    const peak=Math.max(...last.map(x=>x.smile));
    challengeScore=peak>Math.max(.38,neutral*1.35)?1:0;
  }

  const stability=samples.filter(x=>Number.isFinite(x.yaw)&&Number.isFinite(x.blink)).length/samples.length;
  const coverage=Math.min(1,samples.length/16);
  const confidence=Math.round((challengeScore*.65+stability*.2+coverage*.15)*100);
  if(!challengeScore){
    const message=challenge==='blink'?'Blink twice naturally while keeping your face visible.':challenge==='turn_left'?'Turn your head to the left when prompted.':challenge==='turn_right'?'Turn your head to the right when prompted.':'Smile naturally when prompted.';
    return{passed:false,confidence,message,faceCount:1,framesAnalyzed:totalFrames};
  }
  return{passed:true,confidence:Math.max(85,confidence),message:'Live face challenge verified on this device.',faceCount:1,framesAnalyzed:totalFrames};
}

export async function matchLocalFaces(livePhoto:string,profilePhoto:string):Promise<LocalFaceMatchResult>{
  await ensureModels();
  const [liveImage,profileImage]=await Promise.all([loadImage(livePhoto),loadImage(profilePhoto)]);
  const options=new faceapi.TinyFaceDetectorOptions({inputSize:416,scoreThreshold:.6});
  const [liveFaces,profileFaces]=await Promise.all([
    faceapi.detectAllFaces(liveImage,options).withFaceLandmarks().withFaceDescriptors(),
    faceapi.detectAllFaces(profileImage,options).withFaceLandmarks().withFaceDescriptors(),
  ]);
  if(liveFaces.length!==1||profileFaces.length!==1){
    return{passed:false,similarity_percentage:0,confidence:0,feedback:'Each photo must contain exactly one clear face. Please upload a front-facing photo with good lighting.'};
  }
  if(liveFaces[0].detection.score<.65||profileFaces[0].detection.score<.65){
    return{passed:false,similarity_percentage:0,confidence:0,feedback:'The face is not clear enough to verify. Please use a sharper, well-lit photo.'};
  }
  const euclidean=faceapi.euclideanDistance(liveFaces[0].descriptor,profileFaces[0].descriptor);
  const passed=euclidean<=.55;
  const similarity=Math.max(0,Math.min(100,Math.round(95-((euclidean-.35)/.20)*30)));
  const confidence=Math.max(0,Math.min(100,Math.round(100-(euclidean/.7)*100)));
  return{passed,similarity_percentage:similarity,confidence,feedback:passed?'Profile photo matches the verified live face.':'The profile photo does not match the verified live face closely enough. Please upload a clear photo of yourself.'};
}

async function loadImage(src:string):Promise<HTMLImageElement>{return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Could not load image for local verification.'));image.src=src;});}
