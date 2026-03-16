import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import * as CANNON from 'cannon-es';

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const MAX_ROPE        = 10;
const GRAB_STIFFNESS  = 15;
const GRAB_DAMPING    = 8;
const GRAB_RANGE      = 15;
const GRAB_HOLD_DIST  = 3;
const PLAYER_SPEED    = 5;
const CROUCH_SPEED    = 3;
const JUMP_VEL        = 6;
const GRAVITY         = -20;
const EYE_HEIGHT      = 1.7;
const CROUCH_EYE      = 1.0;
const PLAYER_RADIUS   = 0.35;
const STEP_HEIGHT     = 0.55;

// ═══════════════════════════════════════════════════════════════
//  RENDERER  /  SCENE  /  CAMERA
// ═══════════════════════════════════════════════════════════════
const canvas   = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 40, 90);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, EYE_HEIGHT, 5);
scene.add(camera); // needed so camera children (hands) render

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left   = -35;
dirLight.shadow.camera.right  =  35;
dirLight.shadow.camera.top    =  35;
dirLight.shadow.camera.bottom = -35;
scene.add(dirLight);

// ═══════════════════════════════════════════════════════════════
//  GRABPACK  HANDS  (visible FPS hands)
// ═══════════════════════════════════════════════════════════════
const handGeo = new THREE.BoxGeometry(0.08, 0.12, 0.22);

const leftHandMat  = new THREE.MeshStandardMaterial({ color: 0x4ea8ff, roughness: 0.35 });
const rightHandMat = new THREE.MeshStandardMaterial({ color: 0xff4e4e, roughness: 0.35 });

const leftHand  = new THREE.Mesh(handGeo, leftHandMat);
const rightHand = new THREE.Mesh(handGeo, rightHandMat);

// Add "fingers" to each hand
const fingerGeo = new THREE.BoxGeometry(0.02, 0.03, 0.08);
for (let i = 0; i < 4; i++) {
  const lf = new THREE.Mesh(fingerGeo, leftHandMat);
  lf.position.set(-0.03 + i * 0.02, 0.06, -0.05);
  leftHand.add(lf);
  const rf = new THREE.Mesh(fingerGeo, rightHandMat);
  rf.position.set(-0.03 + i * 0.02, 0.06, -0.05);
  rightHand.add(rf);
}

// Rest / grab positions (local to camera)
const HAND_REST_L = new THREE.Vector3(-0.28, -0.22, -0.4);
const HAND_REST_R = new THREE.Vector3( 0.28, -0.22, -0.4);
const HAND_GRAB_L = new THREE.Vector3(-0.06, -0.12, -0.55);
const HAND_GRAB_R = new THREE.Vector3( 0.06, -0.12, -0.55);

leftHand.position.copy(HAND_REST_L);
rightHand.position.copy(HAND_REST_R);
camera.add(leftHand);
camera.add(rightHand);

function updateHands() {
  const lTarget = (grab.active && grab.hand === 'left')  ? HAND_GRAB_L : HAND_REST_L;
  const rTarget = (grab.active && grab.hand === 'right') ? HAND_GRAB_R : HAND_REST_R;
  leftHand.position.lerp(lTarget, 0.18);
  rightHand.position.lerp(rTarget, 0.18);
}

// ═══════════════════════════════════════════════════════════════
//  PHYSICS WORLD
// ═══════════════════════════════════════════════════════════════
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.NaiveBroadphase();
const phyMat = new CANNON.Material('default');
world.addContactMaterial(new CANNON.ContactMaterial(phyMat, phyMat, {
  friction: 0.4, restitution: 0.3,
}));
world.defaultContactMaterial.friction = 0.4;

const syncPairs = [];
function syncBodies() {
  for (const p of syncPairs) {
    p.mesh.position.copy(p.body.position);
    p.mesh.quaternion.copy(p.body.quaternion);
  }
}

// ═══════════════════════════════════════════════════════════════
//  MATERIALS
// ═══════════════════════════════════════════════════════════════
const matFloor   = new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.85 });
const matStatic  = new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.7 });
const matPillar  = new THREE.MeshStandardMaterial({ color: 0x667788, roughness: 0.6 });
const matBox     = new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.4 });
const matHandle  = new THREE.MeshStandardMaterial({ color: 0xccaa33, roughness: 0.3, metalness: 0.6 });
const matDoor    = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.5 });
const matScanB   = new THREE.MeshStandardMaterial({ color: 0x4ea8ff, emissive: 0x4ea8ff, emissiveIntensity: 0.5 });

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
const wrapObstacles   = [];    // rope wrapping targets
const groundMeshes    = [];    // surfaces player can stand on
const collisionMeshes = [];    // horizontal collision (walls, pillars, etc.)

function addStaticBox(w, h, d, x, y, z, mat, opts = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || matStatic);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.static = true;
  mesh.geometry.computeBoundingBox();
  scene.add(mesh);

  const body = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
    position: new CANNON.Vec3(x, y, z),
    material: phyMat,
  });
  world.addBody(body);

  if (opts.wrap    !== false) wrapObstacles.push(mesh);
  if (opts.ground  !== false) groundMeshes.push(mesh);
  if (opts.collide !== false) collisionMeshes.push(mesh);
  return { mesh, body };
}

// ═══════════════════════════════════════════════════════════════
//  WORLD  GEOMETRY
// ═══════════════════════════════════════════════════════════════

// Floor (ground only — not a collision wall or wrap target)
const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), matFloor);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.receiveShadow = true;
scene.add(floorMesh);
groundMeshes.push(floorMesh);

const floorBody = new CANNON.Body({
  mass: 0, shape: new CANNON.Plane(), material: phyMat,
});
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

const grid = new THREE.GridHelper(200, 100, 0x444466, 0x333355);
grid.position.y = 0.005;
scene.add(grid);

// ── Test pillars ──
addStaticBox(0.5, 4, 0.5,  4,  2,  -6, matPillar);
addStaticBox(0.5, 4, 0.5, -4,  2,  -6, matPillar);
addStaticBox(4,  1.5, 0.5,  0, 0.75, -10, matStatic);

// ── Door area ──
addStaticBox(4, 5, 0.5, -3,  2.5, -18, matStatic);
addStaticBox(4, 5, 0.5,  5,  2.5, -18, matStatic);
addStaticBox(2, 2, 0.5,  1,  4,   -18, matStatic);

// Door slab (animated — added to collision, removed when opened)
const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.3), matDoor);
doorMesh.position.set(1, 1.5, -18);
doorMesh.castShadow = true;
doorMesh.geometry.computeBoundingBox();
scene.add(doorMesh);
collisionMeshes.push(doorMesh);

// Scanner panel
const scannerMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.1), matScanB);
scannerMesh.position.set(-0.8, 1.5, -17.7);
scannerMesh.userData.scanner = true;
scannerMesh.userData.requiredHand = 'left';
scene.add(scannerMesh);

let doorOpen = false, doorAnimating = false;

// ── Stairs (8 steps) ──
for (let i = 0; i < 8; i++) {
  const h = (i + 1) * 0.5;
  addStaticBox(2, h, 0.6,  1, h / 2, -22 - i * 0.6, matStatic);
}

// ── Platforms ──
addStaticBox(5, 0.5, 5, -1.5, 4, -28, matStatic);
addStaticBox(5, 0.5, 5,  6.5, 4, -28, matStatic);

// ═══════════════════════════════════════════════════════════════
//  GRABBABLE  OBJECTS
// ═══════════════════════════════════════════════════════════════
const grabbables = [];

const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), matBox.clone());
boxMesh.position.set(0, 0.5, -3);
boxMesh.castShadow = true;
boxMesh.userData.grabbable = true;
boxMesh.userData.type = 'object';
scene.add(boxMesh);
grabbables.push(boxMesh);

const boxBody = new CANNON.Body({
  mass: 5,
  shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
  position: new CANNON.Vec3(0, 0.5, -3),
  material: phyMat,
});
world.addBody(boxBody);
syncPairs.push({ mesh: boxMesh, body: boxBody });

// ── Handles ──
function createHandle(x, y, z) {
  const geo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 12);
  geo.rotateZ(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, matHandle);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.userData.grabbable = true;
  mesh.userData.type = 'handle';
  scene.add(mesh);
  grabbables.push(mesh);

  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 2, 6),
    matStatic,
  );
  rod.position.set(x, y + 1, z);
  scene.add(rod);
  return mesh;
}

createHandle(0,   3, -6);
createHandle(2.5, 6, -28);

// ═══════════════════════════════════════════════════════════════
//  PLAYER  STATE
// ═══════════════════════════════════════════════════════════════
let playerY    = EYE_HEIGHT;
let playerVelY = 0;
let grounded   = true;
let crouching  = false;

// ═══════════════════════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════════════════════
const keys  = {};
const mouse = { left: false, right: false };

window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup',   e => { keys[e.code] = false; });
window.addEventListener('mousedown', e => {
  if (e.button === 0) mouse.left  = true;
  if (e.button === 2) mouse.right = true;
});
window.addEventListener('mouseup', e => {
  if (e.button === 0) mouse.left  = false;
  if (e.button === 2) mouse.right = false;
});
window.addEventListener('contextmenu', e => e.preventDefault());

// ═══════════════════════════════════════════════════════════════
//  POINTER  LOCK
// ═══════════════════════════════════════════════════════════════
const controls = new PointerLockControls(camera, document.body);
const overlay  = document.getElementById('overlay');
overlay.addEventListener('click', () => controls.lock());
controls.addEventListener('lock',   () => overlay.classList.add('hidden'));
controls.addEventListener('unlock', () => overlay.classList.remove('hidden'));

// ═══════════════════════════════════════════════════════════════
//  GRAB  STATE
// ═══════════════════════════════════════════════════════════════
const raycaster = new THREE.Raycaster();
raycaster.far = GRAB_RANGE;

const grab = {
  active:     false,
  hand:       null,
  target:     null,
  targetBody: null,
  isSwing:    false,
  anchor:     new THREE.Vector3(),
  wrapPoints: [],
  ropeUsed:   0,
};

// Rope visual
const ropeGeo = new THREE.BufferGeometry();
const ropeMat = new THREE.LineBasicMaterial({ color: 0xffffff });
const ropeLine = new THREE.Line(ropeGeo, ropeMat);
ropeLine.frustumCulled = false;
scene.add(ropeLine);

// ═══════════════════════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════════════════════
const hudHandL = document.getElementById('hand-left');
const hudHandR = document.getElementById('hand-right');
const hudRopeL = document.getElementById('rope-bar-left');
const hudRopeR = document.getElementById('rope-bar-right');

function updateHUD() {
  hudHandL.classList.toggle('active', grab.active && grab.hand === 'left');
  hudHandR.classList.toggle('active', grab.active && grab.hand === 'right');
  const pct = Math.max(0, 1 - grab.ropeUsed / MAX_ROPE);
  const h   = (pct * 100) + '%';
  hudRopeL.style.height = h;
  hudRopeR.style.height = h;
}

// ═══════════════════════════════════════════════════════════════
//  ROPE  PATH  HELPERS
// ═══════════════════════════════════════════════════════════════
function ropePath() {
  const pts = [camera.position.clone()];
  for (const wp of grab.wrapPoints) pts.push(wp.clone());
  if (grab.target) pts.push(grab.target.position.clone());
  return pts;
}

// Visual path starts from the hand mesh (world-space)
function ropeVisualPath() {
  const pts = [];
  if (grab.active) {
    const handMesh = grab.hand === 'left' ? leftHand : rightHand;
    const wp = new THREE.Vector3();
    handMesh.getWorldPosition(wp);
    pts.push(wp);
  } else {
    pts.push(camera.position.clone());
  }
  for (const wp of grab.wrapPoints) pts.push(wp.clone());
  if (grab.target) pts.push(grab.target.position.clone());
  return pts;
}

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  return len;
}

// ═══════════════════════════════════════════════════════════════
//  ROPE  WRAPPING
// ═══════════════════════════════════════════════════════════════
const _wr = new THREE.Raycaster();

function updateWrapPoints() {
  if (!grab.active || !grab.target) return;

  const pts = ropePath();

  // Add wrap points where segments hit static geometry
  if (pts.length >= 2) {
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    checkSegmentWrap(a, b, grab.wrapPoints.length);
  }
  if (grab.wrapPoints.length > 0) {
    const a = camera.position;
    const b = grab.wrapPoints[0];
    checkSegmentWrap(a, b, 0);
  }

  // Unwrap: remove wrap points no longer needed
  for (let i = grab.wrapPoints.length - 1; i >= 0; i--) {
    const prev = i === 0 ? camera.position : grab.wrapPoints[i - 1];
    const next = i === grab.wrapPoints.length - 1
      ? grab.target.position
      : grab.wrapPoints[i + 1];

    const dir  = new THREE.Vector3().subVectors(next, prev);
    const dist = dir.length();
    if (dist < 0.01) { grab.wrapPoints.splice(i, 1); continue; }
    dir.normalize();

    _wr.set(prev, dir);
    _wr.far = dist;
    const hits = _wr.intersectObjects(wrapObstacles);
    if (hits.length === 0) grab.wrapPoints.splice(i, 1);
  }

  grab.ropeUsed = pathLength(ropePath());
}

function checkSegmentWrap(a, b, insertIdx) {
  const dir  = new THREE.Vector3().subVectors(b, a);
  const dist = dir.length();
  if (dist < 0.05) return;
  dir.normalize();

  _wr.set(a, dir);
  _wr.far = dist - 0.05;
  const hits = _wr.intersectObjects(wrapObstacles);
  if (hits.length > 0) {
    const hp = hits[0].point.clone();
    if (hits[0].face) hp.add(hits[0].face.normal.clone().multiplyScalar(0.06));
    grab.wrapPoints.splice(insertIdx, 0, hp);
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROPE  VISUAL
// ═══════════════════════════════════════════════════════════════
function updateRopeVisual() {
  if (!grab.active) { ropeLine.visible = false; return; }

  const pts = ropeVisualPath();
  const arr = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    arr[i * 3]     = pts[i].x;
    arr[i * 3 + 1] = pts[i].y;
    arr[i * 3 + 2] = pts[i].z;
  }
  ropeGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  ropeGeo.computeBoundingSphere();
  ropeLine.visible = true;
  ropeMat.color.set(grab.hand === 'left' ? 0x4ea8ff : 0xff4e4e);
}

// ═══════════════════════════════════════════════════════════════
//  GRABPACK  —  INITIATE  /  RELEASE
// ═══════════════════════════════════════════════════════════════
const swingVel = new THREE.Vector3();

function tryGrab(hand) {
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObjects(grabbables);
  if (hits.length === 0) return;

  const hit = hits[0];
  if (hit.distance > MAX_ROPE) return;

  grab.active     = true;
  grab.hand       = hand;
  grab.target     = hit.object;
  grab.wrapPoints = [];
  grab.ropeUsed   = hit.distance;

  if (hit.object.userData.type === 'object') {
    const pair = syncPairs.find(p => p.mesh === hit.object);
    grab.targetBody = pair ? pair.body : null;
    grab.isSwing    = false;
  } else {
    // Handle → swing mode
    grab.targetBody = null;
    grab.isSwing    = true;
    grab.anchor.copy(hit.object.position);

    // Launch player toward the handle so the swing actually works
    const toAnchor = new THREE.Vector3().subVectors(
      hit.object.position, camera.position
    );
    toAnchor.normalize().multiplyScalar(10);
    swingVel.copy(toAnchor);

    // Lift off ground
    grounded = false;
  }
}

function releaseGrab() {
  if (grab.target && grab.target.material && grab.target.material.emissive) {
    grab.target.material.emissive.set(0x000000);
  }

  // If releasing swing, transfer swing velocity back to player
  if (grab.isSwing) {
    playerVelY = swingVel.y;
    // Horizontal momentum is kept via camera position changes
  }

  grab.active     = false;
  grab.hand       = null;
  grab.target     = null;
  grab.targetBody = null;
  grab.isSwing    = false;
  grab.wrapPoints = [];
  grab.ropeUsed   = 0;
}

// ═══════════════════════════════════════════════════════════════
//  GRABPACK  —  APPLY  FORCE  (object type)
// ═══════════════════════════════════════════════════════════════
function applyGrabForce() {
  if (!grab.active || grab.isSwing || !grab.targetBody) return;

  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const holdTarget = camera.position.clone().add(camDir.multiplyScalar(GRAB_HOLD_DIST));

  // Enforce rope limit
  const totalUsed = grab.ropeUsed;
  if (totalUsed > MAX_ROPE) {
    const lastAnchor = grab.wrapPoints.length > 0
      ? grab.wrapPoints[grab.wrapPoints.length - 1]
      : camera.position;

    const pathPts = ropePath();
    let usedBeforeLast = 0;
    for (let i = 1; i < pathPts.length - 1; i++) {
      usedBeforeLast += pathPts[i].distanceTo(pathPts[i - 1]);
    }
    const maxLastSeg = MAX_ROPE - usedBeforeLast;

    const toObj = new THREE.Vector3().subVectors(
      new THREE.Vector3().copy(grab.targetBody.position),
      lastAnchor,
    );
    if (toObj.length() > maxLastSeg && maxLastSeg > 0) {
      toObj.normalize().multiplyScalar(maxLastSeg);
      const constrained = lastAnchor.clone().add(toObj);

      const bp = grab.targetBody.position;
      grab.targetBody.applyForce(new CANNON.Vec3(
        (constrained.x - bp.x) * 40,
        (constrained.y - bp.y) * 40,
        (constrained.z - bp.z) * 40,
      ));

      const outDir = new CANNON.Vec3().copy(toObj.normalize());
      const velDot = grab.targetBody.velocity.dot(outDir);
      if (velDot > 0) {
        grab.targetBody.velocity.x -= outDir.x * velDot;
        grab.targetBody.velocity.y -= outDir.y * velDot;
        grab.targetBody.velocity.z -= outDir.z * velDot;
      }
      return;
    }
  }

  // Normal spring force
  const bp = grab.targetBody.position;
  const bv = grab.targetBody.velocity;
  grab.targetBody.applyForce(new CANNON.Vec3(
    (holdTarget.x - bp.x) * GRAB_STIFFNESS - bv.x * GRAB_DAMPING,
    (holdTarget.y - bp.y) * GRAB_STIFFNESS - bv.y * GRAB_DAMPING,
    (holdTarget.z - bp.z) * GRAB_STIFFNESS - bv.z * GRAB_DAMPING,
  ));

  if (grab.target.material.emissive) {
    grab.target.material.emissive.set(grab.hand === 'left' ? 0x1a4488 : 0x881a1a);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SWING  MECHANIC  (proper pendulum)
// ═══════════════════════════════════════════════════════════════
function updateSwing(dt) {
  if (!grab.isSwing) return;

  const anchor = grab.wrapPoints.length > 0
    ? grab.wrapPoints[grab.wrapPoints.length - 1]
    : grab.anchor;

  // Compute max rope for this segment
  const pathPts = ropePath();
  let usedBefore = 0;
  for (let i = 1; i < pathPts.length - 1; i++) {
    usedBefore += pathPts[i].distanceTo(pathPts[i - 1]);
  }
  const maxLen = Math.max(0.5, MAX_ROPE - usedBefore);

  // Gravity
  swingVel.y += GRAVITY * dt;

  // WASD pumping
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
  const pump = 12;
  if (keys['KeyW']) swingVel.add(fwd.clone().multiplyScalar( pump * dt));
  if (keys['KeyS']) swingVel.add(fwd.clone().multiplyScalar(-pump * dt));
  if (keys['KeyA']) swingVel.add(right.clone().multiplyScalar(-pump * dt));
  if (keys['KeyD']) swingVel.add(right.clone().multiplyScalar( pump * dt));

  // Tentative new position
  const newPos = camera.position.clone().add(swingVel.clone().multiplyScalar(dt));

  // Rope constraint: clamp distance to anchor
  const offset = new THREE.Vector3().subVectors(newPos, anchor);
  const dist   = offset.length();
  if (dist > maxLen) {
    offset.normalize().multiplyScalar(maxLen);
    newPos.copy(anchor).add(offset);
  }

  // Back-compute velocity from the constrained movement
  // This naturally makes velocity tangential to the rope
  const actualMove = new THREE.Vector3().subVectors(newPos, camera.position);
  swingVel.copy(actualMove.divideScalar(Math.max(dt, 0.001)));

  // Light damping (rope isn't perfectly elastic)
  swingVel.multiplyScalar(0.998);

  camera.position.copy(newPos);

  // Ground / platform collision
  const gY = getGroundY(camera.position) + EYE_HEIGHT;
  if (camera.position.y < gY) {
    camera.position.y = gY;
    playerY  = gY;
    playerVelY = 0;
    grounded = true;
    releaseGrab();
    return;
  }

  playerY  = camera.position.y;
  grounded = false;
}

// ═══════════════════════════════════════════════════════════════
//  GROUND  DETECTION
// ═══════════════════════════════════════════════════════════════
const _downRay = new THREE.Raycaster();
_downRay.far = 100;

function getGroundY(pos) {
  _downRay.set(
    new THREE.Vector3(pos.x, pos.y + 0.1, pos.z),
    new THREE.Vector3(0, -1, 0),
  );
  const hits = _downRay.intersectObjects(groundMeshes);
  let best = 0;
  for (const h of hits) {
    // Only count upward-facing surfaces (not wall sides)
    if (h.face && h.face.normal) {
      const wn = h.face.normal.clone();
      if (h.object.matrixWorld) wn.transformDirection(h.object.matrixWorld);
      if (wn.y < 0.7) continue;
    }
    if (h.point.y <= pos.y + 0.1 && h.point.y > best) best = h.point.y;
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════
//  HORIZONTAL  COLLISION
// ═══════════════════════════════════════════════════════════════
const _colRay = new THREE.Raycaster();
const _colDirs = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
].map(d => new THREE.Vector3(...d).normalize());

function resolveCollisions() {
  const feetY  = camera.position.y - (crouching ? CROUCH_EYE : EYE_HEIGHT);

  // Cast rays at two heights: knee (0.3m) and chest (1.0m)
  const checkHeights = [feetY + 0.3, feetY + 1.0];

  for (const checkY of checkHeights) {
    const origin = new THREE.Vector3(camera.position.x, checkY, camera.position.z);

    for (const dir of _colDirs) {
      _colRay.set(origin, dir);
      _colRay.far = PLAYER_RADIUS;

      const hits = _colRay.intersectObjects(collisionMeshes);
      if (hits.length === 0) continue;

      const hit  = hits[0];
      const mesh = hit.object;
      const bb   = mesh.geometry.boundingBox;
      const topY = mesh.position.y + bb.max.y;

      // If the top of this object is within step-up height, let ground detection handle it
      if (topY <= feetY + STEP_HEIGHT) continue;

      // Otherwise it's a wall — push the player out
      const push = PLAYER_RADIUS - hit.distance;
      if (push > 0.001) {
        camera.position.x -= dir.x * push;
        camera.position.z -= dir.z * push;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  DOOR  /  SCANNER
// ═══════════════════════════════════════════════════════════════
function checkScanner() {
  if (doorOpen || doorAnimating) return;
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObject(scannerMesh);
  if (hits.length === 0 || hits[0].distance > 3) return;

  const req = scannerMesh.userData.requiredHand;
  const ok  = (req === 'left' && mouse.left) || (req === 'right' && mouse.right);
  if (ok) {
    doorOpen = true;
    doorAnimating = true;
    scannerMesh.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1,
    });
    // Remove door from collision when it opens
    const idx = collisionMeshes.indexOf(doorMesh);
    if (idx !== -1) collisionMeshes.splice(idx, 1);
  }
}

function updateDoor(dt) {
  if (!doorAnimating) return;
  doorMesh.position.y += 2 * dt;
  if (doorMesh.position.y >= 4.5) {
    doorMesh.position.y = 4.5;
    doorAnimating = false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  PLAYER  MOVEMENT
// ═══════════════════════════════════════════════════════════════
function updatePlayer(dt) {
  if (grab.isSwing) { updateSwing(dt); return; }

  crouching = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  const targetEye = crouching ? CROUCH_EYE : EYE_HEIGHT;
  const speed     = crouching ? CROUCH_SPEED : PLAYER_SPEED;

  // WASD movement
  const mv = new THREE.Vector3();
  if (keys['KeyW']) mv.z -= 1;
  if (keys['KeyS']) mv.z += 1;
  if (keys['KeyA']) mv.x -= 1;
  if (keys['KeyD']) mv.x += 1;
  mv.normalize();
  if (mv.lengthSq() > 0) {
    controls.moveForward(-mv.z * speed * dt);
    controls.moveRight(mv.x * speed * dt);
  }

  // Horizontal collision (BEFORE ground detection — prevents wall-teleport)
  resolveCollisions();

  // Jump
  if (keys['Space'] && grounded) {
    playerVelY = JUMP_VEL;
    grounded = false;
  }

  // Gravity
  playerVelY += GRAVITY * dt;
  playerY    += playerVelY * dt;

  // Ground detection
  const groundY = getGroundY(camera.position) + targetEye;
  if (playerY <= groundY) {
    playerY    = groundY;
    playerVelY = 0;
    grounded   = true;
  }

  camera.position.y = playerY;
}

// ═══════════════════════════════════════════════════════════════
//  RESIZE
// ═══════════════════════════════════════════════════════════════
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ═══════════════════════════════════════════════════════════════
//  GAME  LOOP
// ═══════════════════════════════════════════════════════════════
const clock = new THREE.Clock();

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!controls.isLocked) return;

  // Physics
  world.step(1 / 60, dt, 3);
  syncBodies();

  // Player
  updatePlayer(dt);

  // Grabpack input
  if (!grab.active) {
    if (mouse.left)       tryGrab('left');
    else if (mouse.right) tryGrab('right');
  } else {
    const held = (grab.hand === 'left'  && mouse.left) ||
                 (grab.hand === 'right' && mouse.right);
    if (!held) releaseGrab();
  }

  // Rope + force
  updateWrapPoints();
  applyGrabForce();

  // Visuals
  updateRopeVisual();
  updateHands();

  // Door
  checkScanner();
  updateDoor(dt);

  // HUD
  updateHUD();

  // Render
  renderer.render(scene, camera);
}

loop();
