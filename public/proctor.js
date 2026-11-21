// Browser-side proctoring helpers: webcam, face detection (MediaPipe, served locally), snapshots, screen checks.
const MP = '/vendor/mediapipe';
let detectorPromise = null;
let visionPromise = null;

/** Loads the MediaPipe vision bundle and WASM files once; shared by all detectors. */
function loadVision() {
  visionPromise ??= (async () => {
    const vision = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    return { vision, fileset };
  })().catch((e) => { visionPromise = null; throw e; });
  return visionPromise;
}

/** Creates a MediaPipe task on the GPU (several times faster per frame), falling back to the CPU. */
async function createTask(Task, fileset, modelAssetPath, options) {
  try {
    return await Task.createFromOptions(fileset, { baseOptions: { modelAssetPath, delegate: 'GPU' }, ...options });
  } catch (e) {
    console.warn('GPU delegate unavailable, using CPU', e);
    return Task.createFromOptions(fileset, { baseOptions: { modelAssetPath, delegate: 'CPU' }, ...options });
  }
}

/** Loads the BlazeFace detector once. Rejects if WebAssembly/WebGL isn't available. */
export function loadFaceDetector() {
  detectorPromise ??= (async () => {
    const { vision: { FaceDetector }, fileset } = await loadVision();
    return createTask(FaceDetector, fileset, '/models/blaze_face_short_range.tflite', {
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

// ---------- Gaze: where the head and eyes point (MediaPipe Face Landmarker: 478 landmarks, blendshapes, head pose) ----------
let gazePromise = null;
/** Loads the face landmarker once (≈3.7 MB). Rejects if unavailable. */
export function loadGazeTracker() {
  gazePromise ??= (async () => {
    const { vision: { FaceLandmarker }, fileset } = await loadVision();
    // CPU only (~40 ms a frame): on the GPU delegate it reported extra faces that were not in the picture.
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  })().catch((e) => { gazePromise = null; throw e; });
  return gazePromise;
}

// ---------- Object detection (EfficientDet-Lite0, 80 COCO classes) ----------
// Each watched COCO label maps to the proctoring event it raises, with its own confidence threshold.
// 'object_seen' is only logged for the supervisor (a cup of water is fine).
export const WATCHED_OBJECTS = {
  'cell phone': { event: 'phone_detected', minScore: 0.4 }, // phones often score 0.4–0.5 on a webcam
  book: { event: 'book_detected', minScore: 0.55 },
  laptop: { event: 'device_detected', minScore: 0.6 },
  tv: { event: 'device_detected', minScore: 0.6 },
  person: { event: 'extra_person', minScore: 0.6 }, // raised only when 2+ people are seen
  cup: { event: 'object_seen', minScore: 0.5 },
  bottle: { event: 'object_seen', minScore: 0.5 },
};

let objectDetectorPromise = null;
/** Loads the object detector once (≈7 MB float16 model; the int8 one missed more phones). Rejects if unavailable. */
export function loadObjectDetector() {
  objectDetectorPromise ??= (async () => {
    const { vision: { ObjectDetector }, fileset } = await loadVision();
    // CPU only: on the GPU delegate EfficientDet loads without error but returns no detections at all
    // (tested: phone photos give 'cell phone' 0.74–0.79 on CPU, nothing on GPU), so the fallback never ran.
    return ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/efficientdet_lite0_fp16.tflite', delegate: 'CPU' },
      runningMode: 'VIDEO',
      scoreThreshold: 0.35,
      maxResults: 10,
      categoryAllowlist: Object.keys(WATCHED_OBJECTS),
    });
  })().catch((e) => { objectDetectorPromise = null; throw e; });
  return objectDetectorPromise;
}

/**
 * Watched objects in the current frame, as [{ label, event, score }], or null if detection isn't possible.
 * Each detection is kept only above its label's own threshold; 'person' becomes extra_person only for the 2nd+ person.
 */
export function detectObjects(detector, video) {
  if (!detector || video.readyState < 2) return null;
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const found = [];
  let people = 0;
  for (const d of detector.detectForVideo(video, ts).detections) {
    const c = d.categories?.[0];
    const rule = c && WATCHED_OBJECTS[c.categoryName];
    if (!rule || c.score < rule.minScore) continue;
    if (c.categoryName === 'person' && ++people < 2) continue;
    found.push({ label: c.categoryName, event: rule.event, score: Math.round(c.score * 100) / 100 });
  }
  return found;
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
