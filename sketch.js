// =========================
// Marionette
// p5 global mode + MediaPipe hand tracking
//
// Project summary:
// - Camera input, hand landmark extraction, and p5 rendering all happen in this file.
// - Left and right hand landmarks control the two fighters independently.
// - The tracked hand data is mapped to a pixel-art fighting animation instead of being drawn as raw hand skeletons.
// =========================

let HandLandmarker;
let FilesetResolver;
let myHandLandmarker;
let handLandmarks = null;
let trackedHands = { left: null, right: null };
let trackedHandsMeta = { leftX: null, rightX: null };
let myCapture = null;
let lastVideoTime = -1;
let visionReady = false;
let visionInitPromise = null;
let loadingOverlayEl = null;
let hudVideoEl = null;
let debugCanvasEl = null;
let debugCtx = null;
let fightAudioContext = null;
let fightMasterGain = null;
let fightNoiseBuffer = null;
let lastFightSoundAt = 0;

const VISION_FRAME_STRIDE = 2;
let visionFrameTick = 0;

const GRAVITY = 0.5;
const FRICTION = 0.9;
const STRING_STIFFNESS = 0.12;
const ITERATIONS = 4;

const TRAIL_R = 15;
const TRAIL_G = 23;
const TRAIL_B = 42;
const TRAIL_FADE_ALPHA = 0.3;

const IMPACT_VY_THRESHOLD = 7;
const SCATTER_DECAY = 0.91;

const GLOW_STRING = 4;
const GLOW_BONE = 8;
const GLOW_TORSO = 10;
const GLOW_HEAD = 12;
const GLOW_EYE = 6;

const FIGHT_APPROACH = 0.035;
const FIGHT_REACH_MIN = 168;
const FIGHT_REACH_MAX = 420;
const FIGHT_IMPACT_MIN = 18;
const FIGHT_IMPACT_MAX = 46;
const SPARK_DECAY = 0.86;
const FIGHT_SOUND_COOLDOWN_MS = 90;

const PLATFORM_W_RATIO = 0.2;
const PLATFORM_H = 40;
const PLATFORM_MARGIN_BOTTOM = 28;
const PLATFORM_RESTITUTION = 0.22;
const PLATFORM_FRICTION = 0.72;
const IDLE_RETURN_EASE = 0.16;

const STRING_COLOR = "#f7b267";
const LIMB_COLOR = "#f6efe5";
const LIMB_GLOW = "#b6465f";
const JOINT_COLOR = "#ffd166";
const TORSO_FILL = "#24111b";
const TORSO_STROKE = "#ff5d8f";
const TORSO_CORE = "#ffe66d";
const MASK_FILL = "#fff6e9";
const MASK_STROKE = "#ffcad4";
const STAGE_FILL = "rgba(43, 20, 30, 0.92)";
const STAGE_STROKE = "#ff7aa2";
const STAGE_GLOW = "#ff4d6d";
const PIXEL_SIZE = 6;

let containerEl = null;
let puppets = null;

class Particle {
  constructor(x, y, mass = 1) {
    this.x = x;
    this.y = y;
    this.oldx = x;
    this.oldy = y;
    this.mass = mass;
  }

  update() {
    const vx = (this.x - this.oldx) * FRICTION;
    const vy = (this.y - this.oldy) * FRICTION;
    this.oldx = this.x;
    this.oldy = this.y;
    this.x += vx;
    this.y += vy + GRAVITY * this.mass;
  }
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function snapToPixel(value) {
  return Math.round(value / PIXEL_SIZE) * PIXEL_SIZE;
}

function drawPixelRect(x, y, w, h, fillColor, strokeColor = null) {
  rectMode(CORNER);
  if (fillColor) {
    fill(fillColor);
  } else {
    noFill();
  }
  if (strokeColor) {
    stroke(strokeColor);
    strokeWeight(2);
  } else {
    noStroke();
  }
  rect(snapToPixel(x), snapToPixel(y), snapToPixel(w), snapToPixel(h));
}

function drawPixelLine(x1, y1, x2, y2, thickness, colorHex, glowColor) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const steps = Math.max(1, Math.ceil(distance / (PIXEL_SIZE * 0.9)));
  const ctx = drawingContext;
  ctx.save();
  ctx.shadowBlur = GLOW_BONE;
  ctx.shadowColor = glowColor;
  noStroke();
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    drawPixelRect(px - thickness / 2, py - thickness / 2, thickness, thickness, colorHex);
  }
  ctx.restore();
}

function drawPixelBurst(x, y, size, colorHex) {
  const half = size / 2;
  drawPixelRect(x - half, y - PIXEL_SIZE / 2, size, PIXEL_SIZE, colorHex);
  drawPixelRect(x - PIXEL_SIZE / 2, y - half, PIXEL_SIZE, size, colorHex);
}

function showReady() {
  if (!loadingOverlayEl) return;
  const h2 = loadingOverlayEl.querySelector("h2");
  const subtitle = loadingOverlayEl.querySelector(".loading-subtitle");
  const tip = loadingOverlayEl.querySelector(".loading-tip");
  loadingOverlayEl.classList.remove("error");
  if (subtitle) subtitle.textContent = "Camera linked. Fighters entering arena...";
  if (h2) h2.textContent = "READY";
  if (tip) tip.textContent = "Raise both hands to start the fight.";
  loadingOverlayEl.classList.add("ready");
  window.setTimeout(() => {
    loadingOverlayEl.classList.add("hidden");
  }, 220);
}

function showError(message) {
  if (!loadingOverlayEl) return;
  loadingOverlayEl.classList.remove("hidden");
  loadingOverlayEl.classList.remove("ready");
  loadingOverlayEl.classList.add("error");
  const h2 = loadingOverlayEl.querySelector("h2");
  const subtitle = loadingOverlayEl.querySelector(".loading-subtitle");
  const tip = loadingOverlayEl.querySelector(".loading-tip");
  if (h2) h2.textContent = "VISION CORE FAILED";
  if (subtitle) subtitle.textContent = "Camera link interrupted.";
  if (tip) tip.textContent = message;
}

function drawDebugHand(landmarks) {
  if (!debugCanvasEl) return;
  if (!debugCtx) debugCtx = debugCanvasEl.getContext("2d", { alpha: true });
  if (!debugCtx) return;
  debugCtx.lineWidth = 2;
  debugCtx.strokeStyle = "#00ffcc";
  debugCtx.fillStyle = "#ff0055";

  const connections = HandLandmarker.HAND_CONNECTIONS;
  for (const conn of connections) {
    const start = landmarks[conn.start];
    const end = landmarks[conn.end];
    if (start && end) {
      debugCtx.beginPath();
      debugCtx.moveTo(start.x * debugCtx.canvas.width, start.y * debugCtx.canvas.height);
      debugCtx.lineTo(end.x * debugCtx.canvas.width, end.y * debugCtx.canvas.height);
      debugCtx.stroke();
    }
  }

  for (const lm of landmarks) {
    debugCtx.beginPath();
    debugCtx.arc(lm.x * debugCtx.canvas.width, lm.y * debugCtx.canvas.height, 3, 0, 2 * Math.PI);
    debugCtx.fill();
  }
}

function assignTrackedHands(landmarksList) {
  const nextHands = { left: null, right: null };
  const nextMeta = { leftX: null, rightX: null };
  // Keep hand ownership stable by assigning landmarks to the left/right fighter based on screen position.
  const rankedHands = landmarksList
    .map((landmarks) => {
      const anchor = landmarks[0] || landmarks[9] || landmarks[12] || landmarks[8];
      const screenX = anchor ? 1 - anchor.x : 0.5;
      return { landmarks, screenX };
    })
    .sort((a, b) => a.screenX - b.screenX);

  if (rankedHands.length === 1) {
    const onlyHand = rankedHands[0];
    const leftDistance = trackedHandsMeta.leftX == null ? Number.POSITIVE_INFINITY : Math.abs(onlyHand.screenX - trackedHandsMeta.leftX);
    const rightDistance = trackedHandsMeta.rightX == null ? Number.POSITIVE_INFINITY : Math.abs(onlyHand.screenX - trackedHandsMeta.rightX);

    if (leftDistance <= rightDistance) {
      nextHands.left = onlyHand.landmarks;
      nextMeta.leftX = onlyHand.screenX;
    } else {
      nextHands.right = onlyHand.landmarks;
      nextMeta.rightX = onlyHand.screenX;
    }
  } else if (rankedHands.length > 1) {
    const leftHand = rankedHands[0];
    const rightHand = rankedHands[rankedHands.length - 1];
    nextHands.left = leftHand.landmarks;
    nextHands.right = rightHand.landmarks;
    nextMeta.leftX = leftHand.screenX;
    nextMeta.rightX = rightHand.screenX;
  }

  trackedHands = nextHands;
  trackedHandsMeta = nextMeta;
}

async function initializeVisionTracking() {
  if (visionInitPromise) return visionInitPromise;

  visionInitPromise = (async () => {
    loadingOverlayEl = document.getElementById("loading-overlay");
    hudVideoEl = document.getElementById("vision-video");
    debugCanvasEl = document.getElementById("debug-canvas");

    try {
      // This mirrors the teacher-style flow: initialize MediaPipe and camera directly inside sketch.js.
      const mediapipeModule = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm");
      HandLandmarker = mediapipeModule.HandLandmarker;
      FilesetResolver = mediapipeModule.FilesetResolver;

      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
      );

      myHandLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 480 },
          height: { ideal: 360 },
          frameRate: { ideal: 30, max: 30 },
        },
      });

      if (hudVideoEl) {
        hudVideoEl.srcObject = stream;
        await hudVideoEl.play();
        myCapture = hudVideoEl;
      }

      visionReady = true;
      showReady();
    } catch (error) {
      console.error("Vision init error:", error);
      showError("Unable to access the camera or load the hand model. Please check the permissions and network, then refresh the page.");
    }
  })();

  return visionInitPromise;
}

function predictWebcam() {
  if (!visionReady || !myHandLandmarker || !myCapture) return;
  visionFrameTick += 1;

  // Skip some frames so hand tracking does not starve the animation loop.
  if (visionFrameTick % VISION_FRAME_STRIDE === 0 && lastVideoTime !== myCapture.currentTime) {
    handLandmarks = myHandLandmarker.detectForVideo(myCapture, performance.now());
    lastVideoTime = myCapture.currentTime;

    if (debugCanvasEl) {
      if (!debugCtx) debugCtx = debugCanvasEl.getContext("2d", { alpha: true });
      if (debugCtx) debugCtx.clearRect(0, 0, debugCtx.canvas.width, debugCtx.canvas.height);
    }

    if (handLandmarks && Array.isArray(handLandmarks.landmarks) && handLandmarks.landmarks.length > 0) {
      assignTrackedHands(handLandmarks.landmarks);
      handLandmarks.landmarks.forEach((landmarks) => drawDebugHand(landmarks));
    } else {
      trackedHands = { left: null, right: null };
      trackedHandsMeta = { leftX: null, rightX: null };
    }
  }
}

function fadeFrameWithRect() {
  const ctx = drawingContext;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = `rgba(${TRAIL_R}, ${TRAIL_G}, ${TRAIL_B}, ${TRAIL_FADE_ALPHA})`;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function createFightNoiseBuffer(audioContext) {
  const duration = 0.18;
  const frameCount = Math.floor(audioContext.sampleRate * duration);
  const buffer = audioContext.createBuffer(1, frameCount, audioContext.sampleRate);
  const channel = buffer.getChannelData(0);

  for (let i = 0; i < frameCount; i++) {
    const decay = 1 - i / frameCount;
    channel[i] = (Math.random() * 2 - 1) * decay;
  }

  return buffer;
}

function ensureFightAudio() {
  if (fightAudioContext) return fightAudioContext;

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  fightAudioContext = new AudioContextCtor();
  fightMasterGain = fightAudioContext.createGain();
  fightMasterGain.gain.value = 0.3;
  fightMasterGain.connect(fightAudioContext.destination);
  fightNoiseBuffer = createFightNoiseBuffer(fightAudioContext);
  return fightAudioContext;
}

function unlockFightAudio() {
  const audioContext = ensureFightAudio();
  if (!audioContext || audioContext.state !== "suspended") return;
  audioContext.resume().catch(() => {});
}

function createFightOutput(audioContext, panValue) {
  if (typeof audioContext.createStereoPanner === "function") {
    const panner = audioContext.createStereoPanner();
    panner.pan.value = clamp(panValue, -1, 1);
    panner.connect(fightMasterGain);
    return panner;
  }

  const gainNode = audioContext.createGain();
  gainNode.connect(fightMasterGain);
  return gainNode;
}

function playFightSound(intensity = 0.5, pan = 0) {
  const audioContext = ensureFightAudio();
  if (!audioContext || audioContext.state !== "running") return;

  const nowMs = performance.now();
  if (nowMs - lastFightSoundAt < FIGHT_SOUND_COOLDOWN_MS) return;
  lastFightSoundAt = nowMs;

  const hitPower = clamp(intensity, 0.2, 1);
  const now = audioContext.currentTime;
  const output = createFightOutput(audioContext, pan);

  const thump = audioContext.createOscillator();
  const thumpGain = audioContext.createGain();
  thump.type = "triangle";
  thump.frequency.setValueAtTime(180 + hitPower * 60, now);
  thump.frequency.exponentialRampToValueAtTime(55, now + 0.12);
  thumpGain.gain.setValueAtTime(0.0001, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.26 * hitPower, now + 0.008);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
  thump.connect(thumpGain);
  thumpGain.connect(output);
  thump.start(now);
  thump.stop(now + 0.14);

  const snap = audioContext.createOscillator();
  const snapGain = audioContext.createGain();
  snap.type = "square";
  snap.frequency.setValueAtTime(620 + hitPower * 180, now);
  snap.frequency.exponentialRampToValueAtTime(180, now + 0.045);
  snapGain.gain.setValueAtTime(0.0001, now);
  snapGain.gain.exponentialRampToValueAtTime(0.1 + hitPower * 0.06, now + 0.002);
  snapGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  snap.connect(snapGain);
  snapGain.connect(output);
  snap.start(now);
  snap.stop(now + 0.06);

  if (fightNoiseBuffer) {
    const noise = audioContext.createBufferSource();
    const noiseFilter = audioContext.createBiquadFilter();
    const noiseGain = audioContext.createGain();
    noise.buffer = fightNoiseBuffer;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(900 + hitPower * 500, now);
    noiseFilter.Q.value = 0.7;
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.08 + hitPower * 0.06, now + 0.003);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(output);
    noise.start(now);
  }
}

function solveLink(p1, p2, distance, strength = 1.0) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const currentDist = Math.sqrt(dx * dx + dy * dy);
  if (currentDist === 0) return;
  const difference = (distance - currentDist) / currentDist;
  const scalar = difference * 0.5 * strength;
  const offsetX = dx * scalar;
  const offsetY = dy * scalar;
  p1.x += offsetX * (1 / p1.mass);
  p1.y += offsetY * (1 / p1.mass);
  p2.x -= offsetX * (1 / p2.mass);
  p2.y -= offsetY * (1 / p2.mass);
}

function collideParticleWithBox(pt, box, radius) {
  const left = box.x;
  const right = box.x + box.w;
  const top = box.y;
  const bottom = box.y + box.h;

  const nearestX = clamp(pt.x, left, right);
  const nearestY = clamp(pt.y, top, bottom);
  const dx = pt.x - nearestX;
  const dy = pt.y - nearestY;
  if (dx * dx + dy * dy > radius * radius) return false;

  const vx = pt.x - pt.oldx;
  const vy = pt.y - pt.oldy;

  const penLeft = Math.abs((pt.x + radius) - left);
  const penRight = Math.abs(right - (pt.x - radius));
  const penTop = Math.abs((pt.y + radius) - top);
  const penBottom = Math.abs(bottom - (pt.y - radius));
  const minPen = Math.min(penLeft, penRight, penTop, penBottom);

  if (minPen === penTop) {
    pt.y = top - radius;
    pt.oldy = pt.y + Math.max(0, vy) * PLATFORM_RESTITUTION;
    pt.oldx = pt.x - vx * PLATFORM_FRICTION;
    return true;
  }
  if (minPen === penBottom) {
    pt.y = bottom + radius;
    pt.oldy = pt.y + Math.min(0, vy) * PLATFORM_RESTITUTION;
    pt.oldx = pt.x - vx * PLATFORM_FRICTION;
    return true;
  }
  if (minPen === penLeft) {
    pt.x = left - radius;
    pt.oldx = pt.x + Math.max(0, vx) * PLATFORM_RESTITUTION;
    pt.oldy = pt.y - vy * PLATFORM_FRICTION;
    return true;
  }

  pt.x = right + radius;
  pt.oldx = pt.x + Math.min(0, vx) * PLATFORM_RESTITUTION;
  pt.oldy = pt.y - vy * PLATFORM_FRICTION;
  return true;
}

function createPuppet(homeX, variant) {
  const startY = 120;
  return {
    homeX,
    variant,
    scatterEnergy: 0,
    strikePose: 0,
    lastHitFlash: 0,
    particles: {
      head: new Particle(homeX, startY, 1.0),
      neck: new Particle(homeX, startY + 40, 1.2),
      lShoulder: new Particle(homeX - 40, startY + 50, 1.0),
      rShoulder: new Particle(homeX + 40, startY + 50, 1.0),
      lElbow: new Particle(homeX - 50, startY + 110, 0.8),
      rElbow: new Particle(homeX + 50, startY + 110, 0.8),
      lHand: new Particle(homeX - 50, startY + 170, 0.5),
      rHand: new Particle(homeX + 50, startY + 170, 0.5),
      spine: new Particle(homeX, startY + 130, 2.0),
      lHip: new Particle(homeX - 30, startY + 160, 1.2),
      rHip: new Particle(homeX + 30, startY + 160, 1.2),
      lKnee: new Particle(homeX - 30, startY + 240, 1.0),
      rKnee: new Particle(homeX + 30, startY + 240, 1.0),
      lFoot: new Particle(homeX - 30, startY + 320, 0.8),
      rFoot: new Particle(homeX + 30, startY + 320, 0.8),
    },
  };
}

function getIdlePose(puppet, platform) {
  const baseY = platform.y - 320;
  return {
    head: { x: puppet.homeX, y: baseY },
    neck: { x: puppet.homeX, y: baseY + 40 },
    lShoulder: { x: puppet.homeX - 40, y: baseY + 50 },
    rShoulder: { x: puppet.homeX + 40, y: baseY + 50 },
    lElbow: { x: puppet.homeX - 50, y: baseY + 110 },
    rElbow: { x: puppet.homeX + 50, y: baseY + 110 },
    lHand: { x: puppet.homeX - 50, y: baseY + 170 },
    rHand: { x: puppet.homeX + 50, y: baseY + 170 },
    spine: { x: puppet.homeX, y: baseY + 130 },
    lHip: { x: puppet.homeX - 30, y: baseY + 160 },
    rHip: { x: puppet.homeX + 30, y: baseY + 160 },
    lKnee: { x: puppet.homeX - 30, y: baseY + 240 },
    rKnee: { x: puppet.homeX + 30, y: baseY + 240 },
    lFoot: { x: puppet.homeX - 30, y: baseY + 320 },
    rFoot: { x: puppet.homeX + 30, y: baseY + 320 },
  };
}

function easeParticleToPose(particle, target, easing) {
  particle.x += (target.x - particle.x) * easing;
  particle.y += (target.y - particle.y) * easing;
  particle.oldx += (target.x - particle.oldx) * easing;
  particle.oldy += (target.y - particle.oldy) * easing;
}

function initPuppets() {
  const arenaHalfGap = getArenaHalfGap();
  puppets = {
    left: createPuppet(width / 2 - arenaHalfGap, "warrior"),
    right: createPuppet(width / 2 + arenaHalfGap, "monster"),
  };
}

function getPuppetStyle(puppet) {
  if (puppet.variant === "monster") {
    return {
      limbColor: "#9cff57",
      limbGlow: "#2b9348",
      torsoFill: "#132a13",
      torsoStroke: "#80ed99",
      torsoCore: "#f1fa8c",
      maskFill: "#c7f9cc",
      maskStroke: "#57cc99",
      cheekColor: "rgba(87, 204, 153, 0.28)",
      mouthColor: "#081c15",
      eyeColor: "#f1fa8c",
      crownColor: "#80ed99",
      hitColor: "#f1fa8c",
    };
  }

  return {
    limbColor: "#f8f7ff",
    limbGlow: "#6d597a",
    torsoFill: "#2b2d42",
    torsoStroke: "#ff4d8d",
    torsoCore: "#ffd166",
    maskFill: "#fff1e6",
    maskStroke: "#ff85a1",
    cheekColor: "rgba(255, 133, 161, 0.45)",
    mouthColor: "#3b1f2b",
    eyeColor: "#ffe066",
    crownColor: "#8ecae6",
    hitColor: "#ffe066",
  };
}

function drawNeonBone(p1, p2, weightValue, colorHex, glowColor) {
  drawPixelLine(p1.x, p1.y, p2.x, p2.y, Math.max(PIXEL_SIZE, snapToPixel(weightValue)), colorHex, glowColor);
  const ctx = drawingContext;
  ctx.save();
  ctx.shadowBlur = Math.max(2, GLOW_BONE - 2);
  ctx.shadowColor = glowColor;
  drawPixelRect(p1.x - PIXEL_SIZE / 2, p1.y - PIXEL_SIZE / 2, PIXEL_SIZE, PIXEL_SIZE, JOINT_COLOR, "#5a189a");
  ctx.restore();
}

function lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function distanceBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function ensureContainer() {
  if (containerEl) return;
  containerEl = document.getElementById("p5-container");
}

function getFightReach() {
  return clamp(Math.max(width * 0.16, getArenaHalfGap() * 1.45), FIGHT_REACH_MIN, FIGHT_REACH_MAX);
}

function getFightImpact() {
  return clamp(getFightReach() * 0.15, FIGHT_IMPACT_MIN, FIGHT_IMPACT_MAX);
}

function getArenaHalfGap() {
  return clamp(width * 0.19, 120, 320);
}

function getArenaLift() {
  return clamp(height * 0.1, 24, 110);
}

function getPuppetPlatform(puppet) {
  const platformW = Math.max(220, Math.round(width * 0.23));
  return {
    x: puppet.homeX - platformW / 2,
    y: height - PLATFORM_MARGIN_BOTTOM - PLATFORM_H - getArenaLift(),
    w: platformW,
    h: PLATFORM_H,
  };
}

function drawPlatform(platform) {
  const ctx = drawingContext;
  ctx.save();
  ctx.shadowBlur = Math.round(GLOW_TORSO * 0.9);
  ctx.shadowColor = STAGE_GLOW;
  drawPixelRect(platform.x, platform.y, platform.w, platform.h, STAGE_FILL, STAGE_STROKE);
  drawPixelRect(platform.x + 12, platform.y + 8, platform.w - 24, PIXEL_SIZE, "rgba(255, 215, 130, 0.55)");
  drawPixelRect(platform.x + 12, platform.y + platform.h - 14, platform.w - 24, PIXEL_SIZE, "rgba(255, 215, 130, 0.35)");
  ctx.restore();
}

function drawCombatHints(leftPuppet, rightPuppet, leftActive, rightActive) {
  const hudY = 24;
  const panelW = 180;
  const panelH = 40;

  const drawStatusPanel = (x, label, active, accentColor) => {
    drawPixelRect(x, hudY, panelW, panelH, "rgba(25, 16, 28, 0.82)", accentColor);
    fill(active ? "#fff7df" : "#ffcad4");
    noStroke();
    textAlign(LEFT, TOP);
    textSize(14);
    text(label, x + 12, hudY + 8);
    fill(active ? accentColor : "#ff7aa2");
    textSize(11);
    text(active ? "INPUT LIVE" : "WAITING HAND", x + 12, hudY + 24);
  };

  let centerMessage = "HOLD THE ARENA";
  let centerAccent = "#ffd166";

  if (!leftActive && !rightActive) {
    centerMessage = "RAISE BOTH HANDS";
    centerAccent = "#8ecae6";
  } else if (!leftActive) {
    centerMessage = "LEFT SIDE OFFLINE";
    centerAccent = "#ff7aa2";
  } else if (!rightActive) {
    centerMessage = "RIGHT SIDE OFFLINE";
    centerAccent = "#80ed99";
  } else if (leftPuppet.lastHitFlash > 0.34 && rightPuppet.lastHitFlash > 0.34) {
    centerMessage = "DOUBLE IMPACT";
    centerAccent = "#fff0a8";
  } else if (rightPuppet.lastHitFlash > 0.3) {
    centerMessage = "ANGEL STRIKE";
    centerAccent = "#ffe066";
  } else if (leftPuppet.lastHitFlash > 0.3) {
    centerMessage = "MONSTER HIT";
    centerAccent = "#9cff57";
  } else if (leftPuppet.strikePose > 0.48 && rightPuppet.strikePose > 0.48) {
    centerMessage = "CLASH RANGE";
    centerAccent = "#ffd166";
  } else if (leftPuppet.strikePose > 0.52) {
    centerMessage = "WARRIOR PRESSING";
    centerAccent = "#ffe066";
  } else if (rightPuppet.strikePose > 0.52) {
    centerMessage = "MONSTER PRESSING";
    centerAccent = "#80ed99";
  }

  drawStatusPanel(24, "WARRIOR", leftActive, "#ffe066");
  drawStatusPanel(width - panelW - 24, "MONSTER", rightActive, "#80ed99");

  const centerW = Math.max(220, centerMessage.length * 12);
  const centerX = width / 2 - centerW / 2;
  drawPixelRect(centerX, hudY, centerW, panelH, "rgba(28, 18, 34, 0.86)", centerAccent);
  fill(centerAccent);
  noStroke();
  textAlign(CENTER, TOP);
  textSize(15);
  text(centerMessage, width / 2, hudY + 10);
}

function getHandTargets(landmarks, side) {
  if (!landmarks) return null;

  const laneWidth = clamp(width * 0.2, 150, 340);
  const laneOffset = clamp(width * 0.22, 120, 340);
  const laneCenterX = width / 2 + (side === "left" ? -laneOffset : laneOffset);
  const laneX = laneCenterX - laneWidth / 2;
  const laneY = height * 0.08;
  const laneHeight = height * 0.72;

  const getPos = (index) => ({
    x: laneX + (1 - landmarks[index].x) * laneWidth,
    y: laneY + landmarks[index].y * laneHeight,
  });

  return {
    head: getPos(12),
    lHand: getPos(8),
    rHand: getPos(16),
    lFoot: getPos(4),
    rFoot: getPos(20),
  };
}

function applyString(particle, target, stiffness, color) {
  if (!target) return;
  const ctx = drawingContext;
  ctx.save();
  ctx.shadowBlur = GLOW_STRING;
  ctx.shadowColor = color;
  stroke(color);
  strokeWeight(1.5);
  line(target.x, target.y, particle.x, particle.y);
  ctx.restore();

  fill(color);
  noStroke();
  circle(target.x, target.y, 6);
  particle.x += (target.x - particle.x) * stiffness;
  particle.y += (target.y - particle.y) * stiffness;
}

function updatePuppet(puppet, targets, platform, opponent) {
  const pts = puppet.particles;
  const fightReach = getFightReach();
  puppet.scatterEnergy *= SCATTER_DECAY;
  puppet.lastHitFlash *= SPARK_DECAY;
  const hasControlInput = Boolean(targets);

  const ctrlMul = 1 - puppet.scatterEnergy * 0.38;
  if (hasControlInput) {
    // Pull a few key joints toward the tracked hand targets to drive the pose.
    applyString(pts.head, targets.head, STRING_STIFFNESS * ctrlMul, STRING_COLOR);
    applyString(pts.lHand, targets.lHand, STRING_STIFFNESS * ctrlMul, STRING_COLOR);
    applyString(pts.rHand, targets.rHand, STRING_STIFFNESS * ctrlMul, STRING_COLOR);
    applyString(pts.lFoot, targets.lFoot, STRING_STIFFNESS * 0.8 * ctrlMul, STRING_COLOR);
    applyString(pts.rFoot, targets.rFoot, STRING_STIFFNESS * 0.8 * ctrlMul, STRING_COLOR);
  } else {
    // If a hand disappears, ease the fighter back to an idle pose on its platform.
    const idlePose = getIdlePose(puppet, platform);
    Object.entries(idlePose).forEach(([key, target]) => {
      easeParticleToPose(pts[key], target, IDLE_RETURN_EASE);
    });
    puppet.strikePose *= 0.8;
    puppet.scatterEnergy *= 0.9;
  }

  if (hasControlInput && opponent) {
    const opponentSpine = opponent.particles.spine;
    const dir = opponent.homeX > puppet.homeX ? 1 : -1;
    const leadHand = dir > 0 ? pts.rHand : pts.lHand;
    const rearHand = dir > 0 ? pts.lHand : pts.rHand;
    const handDist = Math.min(
      distanceBetween(pts.lHand, opponentSpine),
      distanceBetween(pts.rHand, opponentSpine)
    );
    const reachBlend = 1 - clamp(handDist / (fightReach * 1.15), 0, 1);
    puppet.strikePose += (reachBlend - puppet.strikePose) * 0.18;
    pts.head.x += dir * (8 + puppet.strikePose * 14);
    pts.neck.x += dir * (6 + puppet.strikePose * 11);
    pts.spine.x += dir * (4 + puppet.strikePose * 8);
    leadHand.x += dir * (34 + puppet.strikePose * 56);
    leadHand.y -= 6 + puppet.strikePose * 14;
    rearHand.x += dir * (8 + puppet.strikePose * 16);
    pts.lShoulder.y -= puppet.strikePose * 1.8;
    pts.rShoulder.y -= puppet.strikePose * 1.8;
  } else {
    puppet.strikePose *= 0.82;
  }

  Object.values(pts).forEach((pt) => pt.update());

  const floorY = height - 20;
  const linkMul = Math.max(0.1, 1 - puppet.scatterEnergy * 0.8);
  const iter = Math.max(2, Math.round(ITERATIONS * (1 - puppet.scatterEnergy * 0.45)));

  for (let i = 0; i < iter; i++) {
    // Constraint solving restores the body proportions after target pulling and collisions.
    const link = (a, b, distance, weightValue = 1) => solveLink(a, b, distance, weightValue * linkMul);
    link(pts.head, pts.neck, 35);
    link(pts.neck, pts.lShoulder, 35);
    link(pts.neck, pts.rShoulder, 35);
    link(pts.lShoulder, pts.rShoulder, 70);
    link(pts.neck, pts.spine, 90);
    link(pts.spine, pts.lHip, 35);
    link(pts.spine, pts.rHip, 35);
    link(pts.lHip, pts.rHip, 70);
    link(pts.lShoulder, pts.lHip, 90, 0.05);
    link(pts.rShoulder, pts.rHip, 90, 0.05);
    link(pts.lShoulder, pts.rHip, 110, 0.02);
    link(pts.rShoulder, pts.lHip, 110, 0.02);
    link(pts.lShoulder, pts.lElbow, 65);
    link(pts.lElbow, pts.lHand, 60);
    link(pts.rShoulder, pts.rElbow, 65);
    link(pts.rElbow, pts.rHand, 60);
    link(pts.lHip, pts.lKnee, 80);
    link(pts.lKnee, pts.lFoot, 75);
    link(pts.rHip, pts.rKnee, 80);
    link(pts.rKnee, pts.rFoot, 75);

    Object.values(pts).forEach((pt) => {
      const radius = 7 + (1.2 - Math.min(1.2, pt.mass)) * 3;
      const hit = collideParticleWithBox(pt, platform, radius);
      if (hit) {
        const vy = pt.y - pt.oldy;
        if (vy > IMPACT_VY_THRESHOLD) {
          puppet.scatterEnergy = Math.min(1, puppet.scatterEnergy + Math.min(vy * 0.04, 0.35));
        }
      }
    });

    Object.values(pts).forEach((pt) => {
      if (pt.y > floorY) {
        const vy = pt.y - pt.oldy;
        if (vy > IMPACT_VY_THRESHOLD) {
          puppet.scatterEnergy = Math.min(1, puppet.scatterEnergy + Math.min(vy * 0.045, 0.52));
        }
        pt.y = floorY;
        pt.oldy = pt.y;
        const slip = 0.2 + puppet.scatterEnergy * 0.45;
        pt.oldx += (pt.x - pt.oldx) * slip;
      }
    });
  }

  if (puppet.scatterEnergy > 0.14) {
    const kick = puppet.scatterEnergy * 4.5;
    Object.values(pts).forEach((pt) => {
      const massFactor = 0.55 + pt.mass * 0.35;
      pt.x += random(-kick, kick) * massFactor;
      pt.y += random(-kick * 0.35, kick * 0.12) * massFactor;
      pt.oldx += random(-kick * 0.6, kick * 0.6) * massFactor;
    });
  }
}

function resolvePuppetFight(leftPuppet, rightPuppet) {
  // Compare each lead hand to the opponent head to trigger hit reactions and spark FX.
  const fightReach = getFightReach();
  const fightImpact = getFightImpact();
  const leftPunch = distanceBetween(leftPuppet.particles.rHand, rightPuppet.particles.head);
  const rightPunch = distanceBetween(rightPuppet.particles.lHand, leftPuppet.particles.head);

  if (leftPunch < fightReach) {
    const push = (fightReach - leftPunch) / fightReach;
    rightPuppet.scatterEnergy = Math.min(1, rightPuppet.scatterEnergy + push * 0.22);
    rightPuppet.lastHitFlash = Math.max(rightPuppet.lastHitFlash, 0.5 + push * 0.5);
    rightPuppet.particles.head.x += fightImpact * push;
    rightPuppet.particles.spine.x += fightImpact * 0.55 * push;
    rightPuppet.particles.head.y -= 6 * push;
    playFightSound(push, -0.35);
  }

  if (rightPunch < fightReach) {
    const push = (fightReach - rightPunch) / fightReach;
    leftPuppet.scatterEnergy = Math.min(1, leftPuppet.scatterEnergy + push * 0.22);
    leftPuppet.lastHitFlash = Math.max(leftPuppet.lastHitFlash, 0.5 + push * 0.5);
    leftPuppet.particles.head.x -= fightImpact * push;
    leftPuppet.particles.spine.x -= fightImpact * 0.55 * push;
    leftPuppet.particles.head.y -= 6 * push;
    playFightSound(push, 0.35);
  }
}

function drawFightFX(leftPuppet, rightPuppet) {
  const pairs = [
    [leftPuppet.particles.rHand, rightPuppet.particles.head, rightPuppet.lastHitFlash],
    [rightPuppet.particles.lHand, leftPuppet.particles.head, leftPuppet.lastHitFlash],
  ];

  pairs.forEach(([hand, head, flash]) => {
    if (flash < 0.08) return;
    const impact = lerpPoint(hand, head, 0.42);
    const ctx = drawingContext;
    ctx.save();
    ctx.shadowBlur = 16;
    ctx.shadowColor = "#ffd166";
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 * i) / 6 + frameCount * 0.06;
      const length = 8 + flash * 18;
      drawPixelBurst(
        impact.x + Math.cos(angle) * length,
        impact.y + Math.sin(angle) * length,
        PIXEL_SIZE + flash * PIXEL_SIZE,
        "#ffd166"
      );
    }
    drawPixelRect(
      impact.x - PIXEL_SIZE,
      impact.y - PIXEL_SIZE,
      PIXEL_SIZE * 2,
      PIXEL_SIZE * 2,
      `rgba(255, 245, 210, ${0.45 + flash * 0.35})`
    );
    ctx.restore();
  });
}

function drawPuppet(puppet) {
  const pts = puppet.particles;
  const style = getPuppetStyle(puppet);
  const waist = lerpPoint(pts.lHip, pts.rHip, 0.5);
  const chest = lerpPoint(pts.lShoulder, pts.rShoulder, 0.5);
  const waistLeft = lerpPoint(pts.lHip, pts.spine, 0.25);
  const waistRight = lerpPoint(pts.rHip, pts.spine, 0.25);
  const shoulderLeft = lerpPoint(pts.lShoulder, pts.neck, 0.2);
  const shoulderRight = lerpPoint(pts.rShoulder, pts.neck, 0.2);

  {
    const ctx = drawingContext;
    ctx.save();
    ctx.shadowBlur = GLOW_TORSO;
    ctx.shadowColor = style.torsoStroke;
    if (puppet.variant === "warrior") {
      drawPixelRect(pts.neck.x - 24, pts.neck.y - 12, 48, 18, style.torsoFill, style.torsoStroke);
      drawPixelRect(pts.spine.x - 24, pts.spine.y - 6, 48, 36, style.torsoFill, style.torsoStroke);
      drawPixelRect(pts.lHip.x - 14, pts.lHip.y + 6, 24, 18, style.torsoFill, style.torsoStroke);
      drawPixelRect(pts.rHip.x - 10, pts.rHip.y + 6, 24, 18, style.torsoFill, style.torsoStroke);
      drawPixelRect(pts.neck.x - 6, pts.neck.y + 6, 12, 30, style.crownColor);
      drawPixelRect(pts.spine.x - 6, pts.spine.y + 6, 12, 12, style.torsoCore);
      drawPixelRect(pts.lHand.x - 12, pts.lHand.y + 18, 12, 36, style.torsoStroke);
      drawPixelRect(pts.lHand.x - 18, pts.lHand.y + 48, 24, 12, style.crownColor);

      const wingBaseY = pts.neck.y - 18;
      const leftWingRootX = pts.lShoulder.x - 12;
      const rightWingRootX = pts.rShoulder.x + 12;
      const wingStroke = "#8ecae6";
      const wingCore = "#ffffff";
      const wingMid = "#edf6ff";
      const wingOuter = "#dbeeff";
      const wingGlow = "#cfe8ff";
      drawPixelRect(leftWingRootX - 18, wingBaseY + 6, 12, 24, wingCore, wingStroke);
      drawPixelRect(leftWingRootX - 42, wingBaseY - 12, 24, 12, wingCore, wingStroke);
      drawPixelRect(leftWingRootX - 66, wingBaseY, 30, 12, wingMid, wingStroke);
      drawPixelRect(leftWingRootX - 84, wingBaseY + 18, 30, 12, wingMid, wingStroke);
      drawPixelRect(leftWingRootX - 72, wingBaseY + 36, 36, 12, wingOuter, wingStroke);
      drawPixelRect(leftWingRootX - 48, wingBaseY + 48, 30, 12, wingGlow, wingStroke);
      drawPixelRect(leftWingRootX - 24, wingBaseY + 30, 18, 18, wingCore, wingStroke);
      drawPixelRect(rightWingRootX + 6, wingBaseY + 6, 12, 24, wingCore, wingStroke);
      drawPixelRect(rightWingRootX + 18, wingBaseY - 12, 24, 12, wingCore, wingStroke);
      drawPixelRect(rightWingRootX + 36, wingBaseY, 30, 12, wingMid, wingStroke);
      drawPixelRect(rightWingRootX + 54, wingBaseY + 18, 30, 12, wingMid, wingStroke);
      drawPixelRect(rightWingRootX + 36, wingBaseY + 36, 36, 12, wingOuter, wingStroke);
      drawPixelRect(rightWingRootX + 18, wingBaseY + 48, 30, 12, wingGlow, wingStroke);
      drawPixelRect(rightWingRootX + 6, wingBaseY + 30, 18, 18, wingCore, wingStroke);
    } else {
      drawPixelRect(pts.neck.x - 18, pts.neck.y - 18, 36, 18, style.torsoStroke, style.maskStroke);
      drawPixelRect(pts.spine.x - 30, pts.spine.y - 6, 60, 42, style.torsoFill, style.torsoStroke);
      drawPixelRect(pts.spine.x - 18, pts.spine.y + 30, 36, 18, style.torsoCore, style.torsoStroke);
      drawPixelRect(pts.lShoulder.x - 24, pts.lShoulder.y - 6, 18, 18, style.torsoStroke);
      drawPixelRect(pts.rShoulder.x + 6, pts.rShoulder.y - 6, 18, 18, style.torsoStroke);
      drawPixelRect(pts.rHip.x + 18, pts.rHip.y + 18, 18, 12, style.torsoStroke);
      drawPixelRect(pts.rFoot.x + 12, pts.rFoot.y + 6, 12, 12, style.torsoStroke);
    }

    if (puppet.variant === "warrior") {
      drawPixelRect(pts.spine.x - 6, pts.spine.y - 2, 12, 12, "#fffaf0");
    }
    ctx.restore();
  }

  drawNeonBone(pts.head, pts.neck, 14, style.limbColor, style.limbGlow);
  drawNeonBone(pts.lHip, pts.lKnee, 12, style.limbColor, style.limbGlow);
  drawNeonBone(pts.lKnee, pts.lFoot, 10, style.limbColor, style.limbGlow);
  drawNeonBone(pts.rHip, pts.rKnee, 12, style.limbColor, style.limbGlow);
  drawNeonBone(pts.rKnee, pts.rFoot, 10, style.limbColor, style.limbGlow);
  drawNeonBone(pts.lShoulder, pts.lElbow, 10, style.limbColor, style.limbGlow);
  drawNeonBone(pts.lElbow, pts.lHand, 8, style.limbColor, style.limbGlow);
  drawNeonBone(pts.rShoulder, pts.rElbow, 10, style.limbColor, style.limbGlow);
  drawNeonBone(pts.rElbow, pts.rHand, 8, style.limbColor, style.limbGlow);

  {
    const hx = pts.head.x;
    const hy = pts.head.y;
    const ctx = drawingContext;
    ctx.save();
    ctx.shadowBlur = GLOW_HEAD;
    ctx.shadowColor = puppet.lastHitFlash > 0.08 ? style.hitColor : style.maskStroke;
    if (puppet.variant === "warrior") {
      drawPixelRect(hx - 24, hy - 24, 48, 48, style.maskFill, style.maskStroke);
    } else {
      drawPixelRect(hx - 18, hy - 30, 36, 60, style.maskFill, style.maskStroke);
      drawPixelRect(hx - 30, hy - 18, 12, 36, style.maskFill, style.maskStroke);
      drawPixelRect(hx + 18, hy - 18, 12, 36, style.maskFill, style.maskStroke);
    }

    if (puppet.variant === "warrior") {
      drawPixelRect(hx - 18, hy + 6, 36, 6, style.maskStroke);
    } else {
      drawPixelRect(hx - 18, hy + 12, 36, 6, style.maskStroke);
    }

    if (puppet.variant === "warrior") {
      drawPixelRect(hx - 12, hy - 36, 12, 6, style.crownColor);
      drawPixelRect(hx + 6, hy - 36, 12, 6, style.crownColor);
      drawPixelRect(hx - 6, hy - 42, 12, 6, style.crownColor);
    } else {
      drawPixelRect(hx - 24, hy - 36, 12, 12, style.crownColor);
      drawPixelRect(hx + 12, hy - 36, 12, 12, style.crownColor);
    }

    if (puppet.variant === "warrior") {
      drawPixelRect(hx - 18, hy + 6 + puppet.lastHitFlash * 2, 36, 6, puppet.lastHitFlash > 0.08 ? style.torsoStroke : style.mouthColor);
    } else {
      drawPixelRect(hx - 18, hy + 12, 36, 6, puppet.lastHitFlash > 0.08 ? style.torsoStroke : style.mouthColor);
      drawPixelRect(hx - 12, hy + 18, 6, 6, style.maskFill);
      drawPixelRect(hx + 6, hy + 18, 6, 6, style.maskFill);
    }
    if (puppet.variant === "warrior") {
      drawPixelRect(hx - 24, hy + 6, 6, 12, style.cheekColor);
      drawPixelRect(hx + 18, hy + 6, 6, 12, style.cheekColor);
    } else {
      drawPixelRect(hx - 24, hy + 6, 6, 18, style.cheekColor);
      drawPixelRect(hx + 18, hy + 6, 6, 18, style.cheekColor);
    }

    ctx.shadowBlur = GLOW_EYE;
    ctx.shadowColor = style.eyeColor;
    if (puppet.variant === "warrior") {
      drawPixelRect(hx - 18, hy - 6, 6, 6, style.eyeColor);
      drawPixelRect(hx + 12, hy - 6, 6, 6, style.eyeColor);
    } else {
      drawPixelRect(hx - 18, hy - 6, 12, 6, style.eyeColor);
      drawPixelRect(hx + 6, hy - 6, 12, 6, style.eyeColor);
    }
    drawPixelRect(hx - 12, hy - 6, 6, 6, "#fffdf8");
    drawPixelRect(hx + 18, hy - 6, 6, 6, "#fffdf8");
    ctx.restore();
  }
}

function setup() {
  ensureContainer();
  if (!containerEl) return;

  const canvas = createCanvas(containerEl.clientWidth, containerEl.clientHeight);
  canvas.parent(containerEl);

  pixelDensity(1);
  noSmooth();
  background(TRAIL_R, TRAIL_G, TRAIL_B);
  frameRate(60);
  textFont("monospace");

  window.addEventListener("pointerdown", unlockFightAudio, { passive: true });

  initPuppets();
  initializeVisionTracking();
}

function windowResized() {
  ensureContainer();
  if (!containerEl) return;
  resizeCanvas(containerEl.clientWidth, containerEl.clientHeight);
  background(TRAIL_R, TRAIL_G, TRAIL_B);
  initPuppets();
}

function draw() {
  if (!puppets) return;

  predictWebcam();
  fadeFrameWithRect();

  const leftPlatform = getPuppetPlatform(puppets.left);
  const rightPlatform = getPuppetPlatform(puppets.right);
  const leftTargets = getHandTargets(trackedHands.left, "left");
  const rightTargets = getHandTargets(trackedHands.right, "right");

  drawPlatform(leftPlatform);
  drawPlatform(rightPlatform);

  updatePuppet(puppets.left, leftTargets, leftPlatform, puppets.right);
  updatePuppet(puppets.right, rightTargets, rightPlatform, puppets.left);
  resolvePuppetFight(puppets.left, puppets.right);

  drawPuppet(puppets.left);
  drawPuppet(puppets.right);
  drawFightFX(puppets.left, puppets.right);
  drawCombatHints(puppets.left, puppets.right, Boolean(leftTargets), Boolean(rightTargets));
}

