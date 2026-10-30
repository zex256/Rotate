const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// p5.jsとDOMの境界だけを代用し、実際の自機・描画・生成処理を実行します。
const events = {};
const elements = new Map();
for (const id of ['reset', 'resolution', 'resolution-value', 'course-seed', 'course-controls', 'random-course', 'status']) {
  elements.set(id, { value: '1', textContent: '', reportValidity: () => true,
    addEventListener: (name, callback) => { events[`${id}:${name}`] = callback; } });
}
const polygons = [];
let vertices;
const context = vm.createContext({
  console, performance, URL, URLSearchParams,
  document: { getElementById: id => elements.get(id) ?? null },
  location: { search: '?seed=1', href: 'http://localhost:8766/?seed=1' },
  history: { replaceState() {} },
  pixelDensity() {}, noSmooth() {}, resizeCanvas() {},
  createCanvas: () => ({ elt: { addEventListener(name, callback) { events[`canvas:${name}`] = callback; } } }),
  push() {}, pop() {}, noStroke() {}, fill() {},
  beginShape() { vertices = []; }, vertex(x, y) { vertices.push([x, y]); },
  endShape() { polygons.push(vertices); }, CLOSE: 'close',
  keyIsDown: () => true,
  loadPixels() {}, updatePixels() {},
  pixels: new Uint8ClampedArray(640 * 360 * 4), deltaTime: 1000 / 60, frameCount: 16, frameRate: () => 60
});
const run = code => vm.runInContext(code, context);
run(fs.readFileSync(`${__dirname}/sketch.js`, 'utf8') + `
  globalThis.api = {
    updateVehicle, updateCamera, resetVehicle, setResolution, drawVehicle, renderGround,
    makeRowTable, makeMap, regenerateCourse, setup, draw,
    state: () => ({vehicleX, vehicleZ, vehicleYaw, vehicleRoll, velocityX, velocityZ, speed,
      eyeX, eyeZ, yaw, pitch, eyeHeight, rowTable, courseSeed, mapRows}),
    setState: (x, z, angle, vx, vz) => {
      vehicleX = Math.round(x * FIXED); vehicleZ = Math.round(z * FIXED); vehicleYaw = angle;
      velocityX = Math.round(vx * FIXED); velocityZ = Math.round(vz * FIXED);
      speed = Math.round(Math.hypot(velocityX, velocityZ));
    }
  };
`);
const api = context.api;
const FIXED = 65536;
const WORLD_SIZE = 8192;
const keys = (...codes) => code => codes.includes(code);
const advance = (seconds, input = keys(), fps = 60) => {
  for (let i = 0; i < Math.round(seconds * fps); ++i) api.updateVehicle(1 / fps, input);
  return api.state();
};
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

api.setup();
const initial = api.state();
assert.equal(initial.speed / FIXED, 8);
assert.equal(initial.eyeHeight / FIXED, 24);

// 旋回時も速度を機首へ即座に合わせず、グリップによって横滑りを徐々に抑えます。
api.setState(2000, 2000, 0, 0, 200);
let state = advance(0.05, keys(39));
near(state.vehicleYaw, 0.075, 1e-10, 'steering');
assert.ok(state.velocityX >= 0 && state.velocityX < FIXED, 'inertia does not instantly follow heading');
assert.ok(state.vehicleZ > 2000 * FIXED);
api.setState(2000, 2000, 0, 200, 0);
state = advance(1);
assert.ok(state.velocityX > 50 * FIXED && state.velocityX < 75 * FIXED, 'sideways sliding retains more inertia with weaker grip');
assert.equal(state.velocityZ, 0, 'lateral resistance adds no forward thrust');
api.setState(2000, 2000, 0, 0, 0);
state = advance(1, keys(39));
assert.equal(state.speed, 0, 'turning at rest does not move the vehicle');

// 推力は機首へ加わりますが、既存の慣性を即座に置き換えません。
api.setState(2000, 2000, Math.PI / 2, 0, 200);
state = advance(1, keys(87));
assert.ok(state.velocityX > 80 * FIXED);
assert.ok(state.velocityZ > 60 * FIXED && state.velocityZ < 85 * FIXED);
api.setState(2000, 2000, Math.PI, 0, 200);
state = advance(1, keys(87));
assert.ok(state.velocityZ > 0, 'opposite thrust must first cancel forward inertia');
assert.ok(state.speed < 160 * FIXED);

// 推力を強めても、アクセルを離すと追加の抵抗で明確に減速します。
api.setState(2000, 2000, 0, 0, 0);
state = advance(1, keys(87));
assert.ok(state.speed > 85 * FIXED && state.speed < 100 * FIXED, 'stronger acceleration from rest');
api.setState(2000, 2000, 0, 0, 8);
assert.equal(advance(1).speed, 0);
api.setState(2000, 2000, 0, 0, 100);
state = advance(1);
assert.ok(state.speed > 65 * FIXED && state.speed < 80 * FIXED);
api.setState(2000, 2000, 0, 0, 400);
state = advance(1);
assert.ok(state.speed > 300 * FIXED && state.speed < 325 * FIXED);

// 上限で切り捨てず、低速側・高速側の両方から約420へ収束します。
api.setState(2000, 2000, 0, 0, 0);
state = advance(60, keys(87));
near(state.speed / FIXED, 420, 0.01, 'terminal speed from rest');
api.setState(2000, 2000, 0, 0, 600);
state = advance(1, keys(87));
assert.ok(state.speed > 420 * FIXED && state.speed < 600 * FIXED, 'no artificial speed clamp');
state = advance(59, keys(87));
near(state.speed / FIXED, 420, 0.01, 'terminal speed from above');

// 高速ほど抵抗が大きく、ブレーキは滑る方向と反対に働いて停止します。
api.setState(2000, 2000, 0, 0, 100);
const slowLoss = 100 - advance(1).speed / FIXED;
api.setState(2000, 2000, 0, 0, 400);
assert.ok(400 - advance(1).speed / FIXED > slowLoss * 3);
api.setState(2000, 2000, Math.atan2(120, 160), 120, 160);
state = advance(1, keys(83, 87, 65, 68));
near(state.velocityX / state.velocityZ, 0.75, 0.00001, 'brake preserves travel direction');
state = advance(3, keys(83, 87, 65, 68));
assert.equal(state.speed, 0);
const stoppedX = state.vehicleX;
const stoppedZ = state.vehicleZ;
state = advance(1, keys(83));
assert.equal(state.vehicleX, stoppedX);
assert.equal(state.vehicleZ, stoppedZ);
// 重心移動は停止中に移動を生まず、同じ操作時間なら高速ほど大きく横へ動きます。
for (const input of [keys(65), keys(68), keys(65, 68)]) {
  api.setState(2000, 2000, 0, 0, 0);
  state = advance(1, input);
  assert.equal(state.speed, 0, 'weight shift cannot move a stationary vehicle');
  assert.equal(state.vehicleX, 2000 * FIXED);
  assert.equal(state.vehicleZ, 2000 * FIXED);
}
let lastDisplacement = 0;
for (const forwardSpeed of [50, 100, 200, 400]) {
  api.setState(2000, 2000, 0, 0, forwardSpeed);
  const right = advance(1, keys(68));
  const displacement = right.vehicleX / FIXED - 2000;
  assert.ok(displacement > lastDisplacement, 'higher speed increases weight-shift displacement');
  lastDisplacement = displacement;
  api.setState(2000, 2000, 0, 0, forwardSpeed);
  const left = advance(1, keys(65));
  near(left.vehicleX / FIXED - 2000, -displacement, 0.001, 'left and right weight shifts are symmetric');
}
api.setState(2000, 2000, 0, 0, 0);
state = advance(1, keys(87, 68));
assert.ok(state.vehicleX > 2000 * FIXED && state.velocityZ > 0, 'weight shift takes effect as W builds speed');
assert.equal(state.velocityX, 0, 'weight shift does not accumulate sideways inertia');
const sidePosition = state.vehicleX;
state = advance(0.1);
assert.equal(state.vehicleX, sidePosition, 'weight-shift movement stops immediately after release');
api.setState(2000, 2000, 0, 0, 200);
api.updateVehicle(1 / 60, keys(68));
const firstShiftFrame = api.state();
assert.ok(firstShiftFrame.vehicleX > 2000 * FIXED, 'weight shift starts in the first frame');
api.updateVehicle(1 / 60, keys());
assert.equal(api.state().vehicleX, firstShiftFrame.vehicleX, 'no residual shift in the first released frame');
api.updateVehicle(1 / 60, keys(65));
assert.ok(api.state().vehicleX < firstShiftFrame.vehicleX, 'opposite input takes effect immediately');
const withShift = api.state();
api.setState(2000, 2000, 0, 0, 200);
for (let i = 0; i < 3; ++i) api.updateVehicle(1 / 60, keys());
assert.equal(api.state().velocityX, withShift.velocityX);
assert.equal(api.state().velocityZ, withShift.velocityZ, 'weight shift leaves normal inertia unchanged');
api.setState(2000, 2000, 0, 0, 200);
assert.equal(advance(1, keys(65, 68)).vehicleX, 2000 * FIXED, 'opposite weight-shift inputs cancel');

// 異なるフレーム間隔でも、同じ操作による軌跡と速度がほぼ一致します。
const trajectories = [];
for (const fps of [20, 30, 60, 144]) {
  api.setState(2000, 2000, 0, 0, 200);
  trajectories.push(advance(2, keys(87, 39, 68), fps));
}
for (const value of trajectories) {
  for (const name of ['vehicleX', 'vehicleZ', 'velocityX', 'velocityZ']) {
    // 強い重心移動でも、位置・速度の差は1/32ドット（速度はドット/秒）以内に収めます。
    near(value[name] / FIXED, trajectories[0][name] / FIXED, 1 / 32, `frame independence: ${name}`);
  }
}
api.setState(0.5, 0.5, 0, -200, -200);
state = advance(0.05, keys(), 20);
assert.ok(state.vehicleX > (WORLD_SIZE - 20) * FIXED && state.vehicleX < WORLD_SIZE * FIXED);
assert.ok(state.vehicleZ > (WORLD_SIZE - 20) * FIXED && state.vehicleZ < WORLD_SIZE * FIXED);
console.log('PASS: inertia, thrust, quadratic drag, terminal speed, braking, speed-dependent weight shift, frame timing and wrapping');

// カメラは機首の後方32、高さ24を保ち、投影表を毎回作りません。
const table = api.state().rowTable;
for (const angle of [0, 0.7, Math.PI / 2, Math.PI, -2.4]) {
  api.setState(1, WORLD_SIZE - 1, angle, 100, 100);
  api.updateCamera();
  state = api.state();
  const wrapDelta = value => ((value / FIXED + WORLD_SIZE / 2) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE - WORLD_SIZE / 2;
  const dx = wrapDelta(state.vehicleX - state.eyeX);
  const dz = wrapDelta(state.vehicleZ - state.eyeZ);
  near(Math.hypot(dx, dz), 32, 0.00002, 'camera distance');
  near(dx * Math.cos(angle) - dz * Math.sin(angle), 0, 0.00002, 'camera directly behind');
  assert.equal(state.eyeHeight, 24 * FIXED);
  assert.equal(state.rowTable, table);
}
for (const width of [320, 640, 960, 1280, 1600, 1920]) {
  api.setResolution(width);
  polygons.length = 0;
  api.drawVehicle();
  const height = width * 9 / 16;
  assert.ok(polygons.length >= 2);
  for (const [x, y] of polygons.flat()) {
    assert.ok(x > width * 0.4 && x < width * 0.6);
    assert.ok(y > height * 0.6 && y < height * 0.9, 'vehicle stays in lower screen');
  }
}
api.setResolution(640);
console.log('PASS: chase camera, fixed row table and vehicle projection at all six resolutions');

// 重心移動で機体だけが左右へ傾き、影は地面に残り、離すと即座に水平に戻ります。
api.resetVehicle();
polygons.length = 0;
api.drawVehicle();
const levelPolygons = polygons.slice();
api.updateVehicle(1 / 60, keys(68));
near(api.state().vehicleRoll, Math.PI / 9, 1e-10, 'D leans right');
polygons.length = 0;
api.drawVehicle();
const rightPolygons = polygons.slice();
assert.deepEqual(rightPolygons[0], levelPolygons[0], 'shadow stays flat');
assert.ok(rightPolygons[2][1][1] > levelPolygons[2][1][1], 'right side lowers');
assert.ok(rightPolygons[2][5][1] < levelPolygons[2][5][1], 'left side rises');
api.updateVehicle(1 / 60, keys(65));
near(api.state().vehicleRoll, -Math.PI / 9, 1e-10, 'A leans left');
polygons.length = 0;
api.drawVehicle();
assert.deepEqual(polygons[0], levelPolygons[0]);
assert.ok(polygons[2][1][1] < levelPolygons[2][1][1], 'right side rises when leaning left');
api.updateVehicle(1 / 60, keys());
assert.equal(api.state().vehicleRoll, 0, 'release restores level body immediately');
polygons.length = 0;
api.drawVehicle();
assert.deepEqual(polygons, levelPolygons);
api.updateVehicle(1 / 60, keys(65, 68));
assert.equal(api.state().vehicleRoll, 0, 'opposite inputs cancel lean');
api.updateVehicle(1 / 60, keys(65));
api.resetVehicle();
assert.equal(api.state().vehicleRoll, 0, 'reset clears lean');
console.log('PASS: weight-shift body lean, flat shadow, immediate release and reset');

// 視点だけを操作しても自機は動かず、高度変更では投影表を作り直しません。
api.resetVehicle();
const beforeCameraInput = api.state();
api.updateCamera(0.05, keys(33));
state = api.state();
near(state.eyeHeight / FIXED, 26.5, 1e-8, 'Page Up raises camera');
assert.equal(state.rowTable, beforeCameraInput.rowTable);
api.updateCamera(0.05, keys(34));
assert.equal(api.state().eyeHeight, 24 * FIXED);
api.updateCamera(0.05, keys(38));
state = api.state();
near(state.pitch, beforeCameraInput.pitch - 0.025, 1e-10, 'Up looks down as before');
assert.notEqual(state.rowTable, beforeCameraInput.rowTable);
api.updateCamera(0.05, keys(40));
near(api.state().pitch, beforeCameraInput.pitch, 1e-10, 'Down looks up');
for (const name of ['vehicleX', 'vehicleZ', 'vehicleYaw', 'velocityX', 'velocityZ', 'speed']) {
  assert.equal(api.state()[name], beforeCameraInput[name], `camera input leaves ${name} unchanged`);
}
for (let i = 0; i < 100; ++i) api.updateCamera(0.05, keys(34, 38));
assert.equal(api.state().eyeHeight, FIXED, 'camera height stays above ground');
assert.equal(api.state().pitch, -Math.PI / 2);
for (let i = 0; i < 200; ++i) api.updateCamera(0.05, keys(40));
near(api.state().pitch, Math.PI * 0.39, 1e-10, 'upper pitch limit');
const cameraLimitState = api.state();
api.updateCamera(0.05, keys());
assert.equal(api.state().rowTable, cameraLimitState.rowTable);

// 機体がカメラの後ろにある場合は描かず、手前の面をまたぐ場合も有限の座標で描きます。
run('eyeHeight = 100 * FIXED; pitch = Math.PI * 0.39; rowTable = makeRowTable(VIEW_H, HORIZON, pitch)');
polygons.length = 0;
api.drawVehicle();
assert.equal(polygons.length, 0, 'vehicle behind camera is hidden');
for (const height of [1, 24, 100]) {
  for (const angle of [-Math.PI / 2, -0.4, 0, 0.6, 0.95, Math.PI * 0.39]) {
    run(`eyeHeight = ${height} * FIXED; pitch = ${angle}; rowTable = makeRowTable(VIEW_H, HORIZON, pitch)`);
    polygons.length = 0;
    api.drawVehicle();
    for (const point of polygons.flat()) assert.ok(point.every(Number.isFinite));
  }
}
api.resetVehicle();
console.log('PASS: camera pitch/height controls, independent vehicle state, limits and near-plane clipping');

// 実際のdrawを通し、生成中の停止、フォーカス、パレット更新、リセットを確認します。
api.regenerateCourse(12345);
const beforeGeneration = api.state();
for (let i = 0; i < 64; ++i) api.draw();
assert.equal(api.state().mapRows, 512);
assert.equal(api.state().vehicleX, beforeGeneration.vehicleX);
assert.equal(api.state().vehicleZ, beforeGeneration.vehicleZ);
run('canvasFocused = false');
assert.equal(run('vehicleKeyIsDown(87)'), false);
api.draw();
assert.ok(api.state().speed < 8 * FIXED, 'drag remains active without focus');
events['canvas:focus']();
assert.equal(run('vehicleKeyIsDown(87)'), true);
events['canvas:blur']();
run('mapRows = MAP_SIZE; paletteAnimationMs = 0; glassPulseMs = 0; deltaTime = 60');
const paletteBefore = Array.from(run('palette32'));
api.draw();
const paletteAfter = Array.from(run('palette32'));
for (const start of [128, 232]) {
  for (let i = 0; i < 8; ++i) assert.equal(paletteAfter[start + (i + 1) % 8], paletteBefore[start + i]);
}
for (const i of [19, 20, 127]) assert.equal(paletteAfter[i], paletteBefore[i]);
assert.equal(run('glassPulseMs'), 60);
events['reset:click']();
state = api.state();
assert.equal(state.speed, 8 * FIXED);
assert.equal(state.vehicleX, beforeGeneration.vehicleX);
assert.equal(state.vehicleZ, beforeGeneration.vehicleZ);
near(Math.atan2(state.velocityX, state.velocityZ), state.vehicleYaw, 0.00001, 'reset heading');
assert.equal(state.courseSeed, 12345);
console.log('PASS: setup/draw, map generation, focus, palette animation and reset');
