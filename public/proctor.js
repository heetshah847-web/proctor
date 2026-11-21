// Browser-side proctoring helpers: webcam, face detection (MediaPipe, served locally), snapshots, screen checks.
const MP = '/vendor/mediapipe';
let detectorPromise = null;

/** Loads the BlazeFace detector once. Rejects if WebAssembly/WebGL isn't available. */
export function loadFaceDetector() {
  detectorPromise ??= (async () => {
    const { FilesetResolver, FaceDetector } = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.6,
    });
  })().catch((e) => { detectorPromise = null; throw e; });
  return detectorPromise;
}

export async function openCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a webcam');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

let lastTs = 0;
/** Number of faces in the current frame, or null if detection isn't possible right now. */
export function countFaces(detector, video) {
  if (!detector || video.readyState < 2) return null;
  const ts = Math.max(performance.now(), lastTs + 1); // VIDEO mode needs increasing timestamps
  lastTs = ts;
  return detector.detectForVideo(video, ts).detections.length;
}

/** Small JPEG of the current frame (≈15–30 KB). */
export function snapshot(video) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 240;
  c.getContext('2d').drawImage(video, 0, 0, 320, 240);
  return c.toDataURL('image/jpeg', 0.6);
}

/** Average brightness 0–255; a covered lens is near 0. */
const tiny = document.createElement('canvas');
tiny.width = 32; tiny.height = 24;
export function brightness(video) {
  if (video.readyState < 2) return null;
  const ctx = tiny.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 32, 24);
  const d = ctx.getImageData(0, 0, 32, 24).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return sum / (d.length / 4);
}

/** true = more than one monitor, false = single monitor, null = browser can't tell (non-Chromium). */
export const extendedDisplay = () => (typeof screen.isExtended === 'boolean' ? screen.isExtended : null);

export const browserName = () => {
  const ua = navigator.userAgent;
  return /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
};
