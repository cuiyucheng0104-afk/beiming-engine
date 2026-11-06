import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

let landmarker = null;

async function init() {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );
  landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "IMAGE",
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  return landmarker;
}

// --- Helpers ---
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z||0) + (b.z||0)) / 2 };
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function mapRange(value, avg, deviation, outMin, outMax) {
  const normalized = (value - avg) / deviation;
  return clamp(normalized, outMin, outMax);
}

// Key MediaPipe Face Mesh landmark indices
const LM = {
  // Face outline
  foreheadTop: 10,
  chin: 152,
  leftFace: 234,
  rightFace: 454,
  leftTemple: 127,
  rightTemple: 356,

  // Eyes
  leftEyeInner: 133, leftEyeOuter: 33,
  leftEyeTop: 159, leftEyeBottom: 145,
  rightEyeInner: 362, rightEyeOuter: 263,
  rightEyeTop: 386, rightEyeBottom: 374,

  // Eyebrows
  leftBrowInner: 70, leftBrowMid: 63, leftBrowOuter: 105,
  rightBrowInner: 300, rightBrowMid: 293, rightBrowOuter: 334,

  // Nose
  noseBridgeTop: 6, noseBridgeMid: 197, noseTip: 1,
  noseBottom: 2, leftNostril: 48, rightNostril: 278,
  leftNoseAla: 219, rightNoseAla: 439,

  // Mouth
  mouthLeft: 61, mouthRight: 291,
  upperLipTop: 0, upperLipBottom: 13,
  lowerLipTop: 14, lowerLipBottom: 17,

  // Jaw
  leftJaw: 172, rightJaw: 397,
  leftMidJaw: 132, rightMidJaw: 361,

  // Cheeks
  leftCheek: 123, rightCheek: 352,
  leftCheekbone: 116, rightCheekbone: 345,
};

/**
 * Analyze face from an image element and return 70 parameter values.
 */
export async function analyzeFace(imageElement, onProgress) {
  onProgress?.("Loading AI model...");
  const fl = await init();

  onProgress?.("Detecting face landmarks...");
  const result = fl.detect(imageElement);

  if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
    throw new Error("No face detected in image");
  }

  const lm = result.faceLandmarks[0]; // 478 landmarks
  const bs = result.faceBlendshapes?.[0]?.categories || [];

  onProgress?.("Analyzing facial features...");

  // --- Compute measurements (normalized by face height) ---
  const faceHeight = dist(lm[LM.foreheadTop], lm[LM.chin]);
  const faceWidth = dist(lm[LM.leftFace], lm[LM.rightFace]);
  const n = (v) => v / faceHeight; // normalize

  // Face shape
  const faceRatio = faceWidth / faceHeight; // avg ~0.72
  const jawWidth = dist(lm[LM.leftJaw], lm[LM.rightJaw]);
  const jawRatio = jawWidth / faceWidth; // avg ~0.82
  const midJawWidth = dist(lm[LM.leftMidJaw], lm[LM.rightMidJaw]);
  const taperRatio = midJawWidth / faceWidth; // avg ~0.88

  // Forehead
  const foreheadToEyes = dist(lm[LM.foreheadTop], midpoint(lm[LM.leftEyeTop], lm[LM.rightEyeTop]));
  const foreheadRatio = foreheadToEyes / faceHeight; // avg ~0.33
  const templeWidth = dist(lm[LM.leftTemple], lm[LM.rightTemple]);
  const templeRatio = templeWidth / faceWidth; // avg ~0.92

  // Eyes
  const leftEyeWidth = dist(lm[LM.leftEyeInner], lm[LM.leftEyeOuter]);
  const rightEyeWidth = dist(lm[LM.rightEyeInner], lm[LM.rightEyeOuter]);
  const eyeWidth = (leftEyeWidth + rightEyeWidth) / 2;
  const eyeWidthRatio = eyeWidth / faceWidth; // avg ~0.26

  const leftEyeHeight = dist(lm[LM.leftEyeTop], lm[LM.leftEyeBottom]);
  const rightEyeHeight = dist(lm[LM.rightEyeTop], lm[LM.rightEyeBottom]);
  const eyeHeight = (leftEyeHeight + rightEyeHeight) / 2;
  const eyeOpenRatio = eyeHeight / eyeWidth; // avg ~0.28

  const eyeSpacing = dist(lm[LM.leftEyeInner], lm[LM.rightEyeInner]);
  const eyeSpacingRatio = eyeSpacing / faceWidth; // avg ~0.28

  // Eye tilt (angle of the eye axis)
  const leftTilt = (lm[LM.leftEyeOuter].y - lm[LM.leftEyeInner].y) / leftEyeWidth;
  const rightTilt = (lm[LM.rightEyeInner].y - lm[LM.rightEyeOuter].y) / rightEyeWidth;
  const eyeTilt = (leftTilt + rightTilt) / 2; // positive = outer higher

  // Eye depth (z-coordinate difference)
  const eyeDepthAvg = ((lm[LM.leftEyeTop].z + lm[LM.rightEyeTop].z) / 2);
  const noseDepth = lm[LM.noseTip].z;
  const eyeDepthRatio = (eyeDepthAvg - noseDepth); // more negative = deeper set

  // Eyebrows
  const leftBrowHeight = lm[LM.leftBrowMid].y - lm[LM.leftEyeTop].y;
  const rightBrowHeight = lm[LM.rightBrowMid].y - lm[LM.rightEyeTop].y;
  const browHeight = (leftBrowHeight + rightBrowHeight) / 2;
  const browHeightRatio = browHeight / faceHeight; // more negative = higher brow

  const leftBrowArch = lm[LM.leftBrowMid].y - (lm[LM.leftBrowInner].y + lm[LM.leftBrowOuter].y) / 2;
  const rightBrowArch = lm[LM.rightBrowMid].y - (lm[LM.rightBrowInner].y + lm[LM.rightBrowOuter].y) / 2;
  const browArch = (leftBrowArch + rightBrowArch) / 2;

  const browSpacing = dist(lm[LM.leftBrowInner], lm[LM.rightBrowInner]);
  const browSpacingRatio = browSpacing / faceWidth;

  // Nose
  const noseWidth = dist(lm[LM.leftNoseAla], lm[LM.rightNoseAla]);
  const noseWidthRatio = noseWidth / faceWidth; // avg ~0.30
  const noseLength = dist(lm[LM.noseBridgeTop], lm[LM.noseTip]);
  const noseLengthRatio = noseLength / faceHeight; // avg ~0.28
  const noseBridgeWidth = dist(lm[LM.noseBridgeTop], lm[LM.noseBridgeMid]) > 0
    ? dist(lm[168], lm[6]) : 0; // bridge width approximation
  const nostrilWidth = dist(lm[LM.leftNostril], lm[LM.rightNostril]);
  const nostrilRatio = nostrilWidth / noseWidth; // avg ~0.65

  // Mouth
  const mouthWidth = dist(lm[LM.mouthLeft], lm[LM.mouthRight]);
  const mouthWidthRatio = mouthWidth / faceWidth; // avg ~0.38
  const upperLipThick = dist(lm[LM.upperLipTop], lm[LM.upperLipBottom]);
  const lowerLipThick = dist(lm[LM.lowerLipTop], lm[LM.lowerLipBottom]);
  const upperLipRatio = upperLipThick / faceHeight; // avg ~0.035
  const lowerLipRatio = lowerLipThick / faceHeight; // avg ~0.045

  // Mouth vertical position
  const mouthCenter = midpoint(lm[LM.upperLipBottom], lm[LM.lowerLipTop]);
  const mouthY = (mouthCenter.y - lm[LM.noseTip].y) / (lm[LM.chin].y - lm[LM.noseTip].y); // avg ~0.35

  // Cheeks
  const cheekWidth = dist(lm[LM.leftCheek], lm[LM.rightCheek]);
  const cheekRatio = cheekWidth / faceWidth; // avg ~0.70
  const cheekboneWidth = dist(lm[LM.leftCheekbone], lm[LM.rightCheekbone]);
  const cheekboneRatio = cheekboneWidth / faceWidth;

  // Chin
  const chinWidth = dist(lm[199], lm[200] || lm[152]); // approximate
  const chinToJaw = dist(lm[LM.chin], midpoint(lm[LM.leftJaw], lm[LM.rightJaw]));
  const chinRatio = chinToJaw / faceHeight;

  // Use blendshapes for additional info if available
  const getBS = (name) => bs.find(b => b.categoryName === name)?.score || 0;

  onProgress?.("Mapping to parameters...");

  // --- Map measurements to 70 parameters ---
  const params = {
    // Face Shape (8)
    "Face Width":     mapRange(faceRatio, 0.72, 0.08, -1, 1) * 0.6,
    "Face Height":    mapRange(faceRatio, 0.72, 0.08, 1, -1) * 0.5, // inverse: wider = shorter feel
    "Face Depth":     mapRange(eyeDepthRatio, -0.04, 0.03, -0.5, 0.5),
    "Face Roundness": mapRange(faceRatio, 0.72, 0.06, -0.5, 0.5) * 0.5,
    "Face Taper":     mapRange(1 - taperRatio, 0.12, 0.08, -1, 1) * 0.6,
    "Face Asymmetry": 0,
    "Skull Width":    mapRange(templeRatio, 0.92, 0.05, -0.5, 0.5),
    "Skull Depth":    0,

    // Forehead (6)
    "Forehead Width":  mapRange(templeRatio, 0.92, 0.05, -0.5, 0.5),
    "Forehead Height": mapRange(foreheadRatio, 0.33, 0.04, -1, 1) * 0.5,
    "Forehead Slope":  0,
    "Forehead Bulge":  0,
    "Brow Ridge":      mapRange(browHeightRatio, -0.04, 0.02, 0.5, -0.5),
    "Temple Width":    mapRange(templeRatio, 0.92, 0.05, -0.5, 0.5),

    // Eyes (14)
    "Eye Size":          mapRange(eyeWidthRatio, 0.26, 0.03, -1, 1) * 0.4,
    "Eye Width":         mapRange(eyeWidthRatio, 0.26, 0.03, -1, 1) * 0.5,
    "Eye Height":        mapRange(eyeOpenRatio, 0.28, 0.06, -1, 1) * 0.5,
    "Eye Spacing":       mapRange(eyeSpacingRatio, 0.28, 0.03, -1, 1) * 0.5,
    "Eye Depth":         mapRange(eyeDepthRatio, -0.04, 0.02, -0.5, 0.5),
    "Eye Tilt":          mapRange(eyeTilt, 0, 0.08, -1, 1) * 0.6,
    "Upper Eyelid":      mapRange(eyeOpenRatio, 0.28, 0.06, -0.5, 0.5),
    "Lower Eyelid":      0,
    "Inner Eye Corner":  0,
    "Outer Eye Corner":  mapRange(eyeTilt, 0, 0.08, -0.3, 0.3),
    "Eye Socket Depth":  mapRange(eyeDepthRatio, -0.04, 0.02, -0.3, 0.5),
    "Eye Protrusion":    mapRange(eyeDepthRatio, -0.04, 0.02, 0.3, -0.3),
    "Under Eye Fullness": 0,
    "Eye Bag":            0,

    // Eyebrows (8)
    "Brow Height":       mapRange(browHeightRatio, -0.04, 0.015, 0.5, -0.5),
    "Brow Thickness":    0,
    "Brow Arch":         mapRange(browArch, -0.01, 0.008, -0.5, 0.5),
    "Brow Spacing":      mapRange(browSpacingRatio, 0.16, 0.03, -0.5, 0.5),
    "Brow Inner Height": 0,
    "Brow Outer Height": 0,
    "Brow Angle":        mapRange(browArch, -0.01, 0.008, -0.3, 0.3),
    "Brow Depth":        0,

    // Nose (12)
    "Nose Width":         mapRange(noseWidthRatio, 0.30, 0.04, -1, 1) * 0.5,
    "Nose Height":        0,
    "Nose Length":         mapRange(noseLengthRatio, 0.28, 0.03, -1, 1) * 0.4,
    "Nose Bridge Width":   mapRange(noseWidthRatio * 0.5, 0.15, 0.03, -1, 1) * 0.5,
    "Nose Bridge Depth":   0,
    "Nose Tip Width":      mapRange(noseWidthRatio, 0.30, 0.04, -0.5, 0.5),
    "Nose Tip Height":     0,
    "Nose Tip Protrusion": 0,
    "Nostril Width":       mapRange(nostrilRatio, 0.65, 0.08, -0.5, 0.5),
    "Nostril Height":      0,
    "Nostril Flare":       mapRange(noseWidthRatio, 0.30, 0.04, -0.3, 0.3),
    "Nose Curve":          0,

    // Mouth (10)
    "Mouth Width":          mapRange(mouthWidthRatio, 0.38, 0.04, -1, 1) * 0.5,
    "Mouth Position":       mapRange(mouthY, 0.35, 0.08, -0.3, 0.3),
    "Upper Lip Thickness":  mapRange(upperLipRatio, 0.035, 0.01, -1, 1) * 0.5,
    "Lower Lip Thickness":  mapRange(lowerLipRatio, 0.045, 0.01, -1, 1) * 0.5,
    "Upper Lip Curve":      0,
    "Lower Lip Curve":      0,
    "Lip Protrusion":       0,
    "Mouth Corner Angle":   mapRange(getBS("mouthSmileLeft") + getBS("mouthSmileRight"), 0, 0.3, -0.2, 0.3),
    "Cupid Bow":            0,
    "Philtrum Depth":       0,

    // Cheeks (6)
    "Cheek Width":          mapRange(cheekRatio, 0.70, 0.05, -0.5, 0.5),
    "Cheek Height":         0,
    "Cheek Fullness":       mapRange(cheekRatio, 0.70, 0.05, -0.3, 0.3),
    "Cheekbone Prominence": mapRange(cheekboneRatio, 0.72, 0.04, -0.5, 0.5),
    "Cheek Hollow":         mapRange(1 - cheekRatio, 0.30, 0.05, -0.3, 0.5),
    "Nasolabial Fold":      0,

    // Jaw & Chin (6)
    "Jaw Width":       mapRange(jawRatio, 0.82, 0.06, -1, 1) * 0.6,
    "Jaw Height":      0,
    "Jaw Angle":       mapRange(jawRatio, 0.82, 0.06, -0.5, 0.5),
    "Chin Width":      mapRange(jawRatio * 0.6, 0.49, 0.05, -1, 1) * 0.5,
    "Chin Height":     mapRange(chinRatio, 0.15, 0.03, -0.5, 0.5),
    "Chin Protrusion": 0,
  };

  // Round all values
  for (const key in params) {
    params[key] = Math.round(params[key] * 100) / 100;
  }

  onProgress?.("Done!");
  return params;
}
