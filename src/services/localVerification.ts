import * as faceapi from '@vladmandic/face-api';

export type LocalChallenge = 'blink' | 'turn_left' | 'turn_right' | 'smile';

export interface LocalLivenessResult {
  passed: boolean;
  confidence: number;
  message: string;
  faceCount: number;
  framesAnalyzed: number;
}

export interface LocalFaceMatchResult {
  passed: boolean;
  similarity_percentage: number;
  confidence: number;
  feedback: string;
}

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
let modelsPromise: Promise<void> | null = null;

function distance(a: faceapi.Point, b: faceapi.Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ratio(a: faceapi.Point, b: faceapi.Point, c: faceapi.Point, d: faceapi.Point) {
  return (distance(a, b) + distance(c, d)) / Math.max(0.001, 2 * distance(a, d));
}

async function ensureModels() {
  if (!modelsPromise) {
    modelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]).then(() => undefined).catch((error) => {
      modelsPromise = null;
      throw error;
    });
  }
  return modelsPromise;
}

export async function preloadLocalVerificationModels() {
  await ensureModels();
}

export async function runLocalLiveness(
  video: HTMLVideoElement,
  challenge: LocalChallenge,
  onProgress?: (message: string) => void,
): Promise<LocalLivenessResult> {
  await ensureModels();
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 });
  const started = performance.now();
  const samples: Array<{ yaw: number; blink: number; smile: number; face: faceapi.FaceLandmarks68 }> = [];
  let noFaceFrames = 0;
  let totalFrames = 0;

  while (performance.now() - started < 7000 && samples.length < 24) {
    if (video.readyState >= 2) {
      totalFrames++;
      const result = await faceapi.detectSingleFace(video, options).withFaceLandmarks();
      if (!result) {
        noFaceFrames++;
      } else {
        const p = result.landmarks.positions;
        const leftEye = p.slice(36, 42);
        const rightEye = p.slice(42, 48);
        const mouth = p.slice(48, 68);
        const leftEyeCenter = leftEye.reduce((s, v) => ({ x: s.x + v.x, y: s.y + v.y }), { x: 0, y: 0 });
        const rightEyeCenter = rightEye.reduce((s, v) => ({ x: s.x + v.x, y: s.y + v.y }), { x: 0, y: 0 });
        leftEyeCenter.x /= leftEye.length; leftEyeCenter.y /= leftEye.length;
        rightEyeCenter.x /= rightEye.length; rightEyeCenter.y /= rightEye.length;
        const nose = p[30];
        const eyeMidX = (leftEyeCenter.x + rightEyeCenter.x) / 2;
        const eyeWidth = Math.max(1, distance(leftEyeCenter, rightEyeCenter));
        const yaw = (nose.x - eyeMidX) / eyeWidth;
        const blink = (ratio(leftEye[1], leftEye[5], leftEye[2], leftEye[4]) + ratio(rightEye[1], rightEye[5], rightEye[2], rightEye[4])) / 2;
        const mouthWidth = Math.max(1, distance(mouth[0], mouth[6]));
        const mouthOpen = distance(mouth[3], mouth[9]) / mouthWidth;
        samples.push({ yaw, blink, smile: mouthOpen, face: result.landmarks });
        onProgress?.(`Face detected · ${samples.length}/24 checks`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  if (samples.length < 8) {
    return { passed: false, confidence: 0, message: 'Keep your face centered and clearly visible, then try again.', faceCount: samples.length ? 1 : 0, framesAnalyzed: totalFrames };
  }

  const first = samples.slice(0, Math.min(5, samples.length));
  const last = samples.slice(-Math.min(8, samples.length));
  let challengeScore = 0;

  if (challenge === 'blink') {
    const open = first.reduce((s, x) => s + x.blink, 0) / first.length;
    const minimum = Math.min(...samples.map(x => x.blink));
    challengeScore = minimum < Math.max(0.18, open * 0.58) ? 1 : 0;
  } else if (challenge === 'turn_left') {
    const base = first.reduce((s, x) => s + x.yaw, 0) / first.length;
    const min = Math.min(...last.map(x => x.yaw));
    challengeScore = min < base - 0.13 ? 1 : 0;
  } else if (challenge === 'turn_right') {
    const base = first.reduce((s, x) => s + x.yaw, 0) / first.length;
    const max = Math.max(...last.map(x => x.yaw));
    challengeScore = max > base + 0.13 ? 1 : 0;
  } else {
    const neutral = first.reduce((s, x) => s + x.smile, 0) / first.length;
    const peak = Math.max(...last.map(x => x.smile));
    challengeScore = peak > Math.max(0.38, neutral * 1.35) ? 1 : 0;
  }

  const stability = samples.filter(x => Number.isFinite(x.yaw) && Number.isFinite(x.blink)).length / samples.length;
  const coverage = Math.min(1, samples.length / 16);
  const confidence = Math.round((challengeScore * 0.65 + stability * 0.2 + coverage * 0.15) * 100);

  if (!challengeScore) {
    return { passed: false, confidence, message: challenge === 'blink' ? 'Blink twice naturally while keeping your face visible.' : challenge === 'turn_left' ? 'Turn your head to the left when prompted.' : challenge === 'turn_right' ? 'Turn your head to the right when prompted.' : 'Smile naturally when prompted.', faceCount: 1, framesAnalyzed: totalFrames };
  }

  return { passed: true, confidence: Math.max(85, confidence), message: 'Live face challenge verified on this device.', faceCount: 1, framesAnalyzed: totalFrames };
}

export async function matchLocalFaces(livePhoto: string, profilePhoto: string): Promise<LocalFaceMatchResult> {
  await ensureModels();
  const [liveImage, profileImage] = await Promise.all([loadImage(livePhoto), loadImage(profilePhoto)]);
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.55 });
  const [live, profile] = await Promise.all([
    faceapi.detectSingleFace(liveImage, options).withFaceLandmarks().withFaceDescriptor(),
    faceapi.detectSingleFace(profileImage, options).withFaceLandmarks().withFaceDescriptor(),
  ]);

  if (!live || !profile) {
    return { passed: false, similarity_percentage: 0, confidence: 0, feedback: 'We could not find a clear face in both photos. Please use a front-facing photo with good lighting.' };
  }

  const euclidean = faceapi.euclideanDistance(live.descriptor, profile.descriptor);
  // FaceAPI descriptors are normalized; lower distance means a closer match.
  // 0.55 is deliberately conservative for an identity gate while still
  // tolerating normal expression/lighting differences.
  const passed = euclidean <= 0.55;
  const similarity = Math.max(0, Math.min(100, Math.round((1 - euclidean / 0.95) * 100)));
  return {
    passed,
    similarity_percentage: similarity,
    confidence: Math.round(Math.max(0, Math.min(100, (1 - euclidean / 0.8) * 100))),
    feedback: passed ? 'Profile photo matches the verified live face.' : 'The profile photo does not match the verified live face closely enough. Please upload a clear photo of yourself.',
  };
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image for local verification.'));
    image.src = src;
  });
}
