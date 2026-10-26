const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(`${__dirname}/sketch.js`, 'utf8');
const context = vm.createContext({ console, Uint8ClampedArray, Float64Array });
vm.runInContext(source + '\nglobalThis.api = {renderGround, makeTexture, makeRowTable, VIEW_W, VIEW_H, HORIZON, FOCAL};', context);
const { renderGround, makeTexture, makeRowTable, VIEW_W, VIEW_H, HORIZON, FOCAL } = context.api;
assert.equal(VIEW_W, 640);
assert.equal(VIEW_H, 360);
const HALF_WIDTH = VIEW_W / 2;
const coordinateTolerance = (VIEW_W + 1) / 131072 + 1e-8;
const texture = makeTexture();
const chunkedTexture = new Uint8ClampedArray(512 * 512 * 4);
for (let row = 0; row < 512; row += 8) {
  makeTexture(chunkedTexture, row, Math.min(row + 8, 512));
}
assert.deepEqual(chunkedTexture, texture, 'chunked map generation preserves every RGBA byte');
vm.runInContext(`
  globalThis.pixelDensity = () => {};
  globalThis.createCanvas = () => ({elt: {addEventListener() {}}});
  globalThis.noSmooth = () => {};
  globalThis.document = {getElementById: () => null};
  setup();
  globalThis.generatedSky = skyData;
`, context);
const expectedSkyColor = new Uint8ClampedArray(4);
expectedSkyColor[3] = 255;
for (let y = 0; y < VIEW_H; ++y) {
  const t = Math.min(y / HORIZON, 1);
  expectedSkyColor[0] = 65 + 85 * t;
  expectedSkyColor[1] = 115 + 75 * t;
  expectedSkyColor[2] = 175 + 45 * t;
  for (let x = 0; x < VIEW_W; ++x) {
    for (let channel = 0; channel < 4; ++channel) {
      assert.equal(context.generatedSky[(y * VIEW_W + x) * 4 + channel], expectedSkyColor[channel]);
    }
  }
}
const texture32 = new Uint32Array(texture.buffer, texture.byteOffset, texture.byteLength / 4);
let checked = 0;
let maxError = 0;
for (const pitch of [0, -0.4, 0.4, -Math.PI * 0.39, Math.PI * 0.39, -Math.PI / 2]) {
 const inverse = makeRowTable(VIEW_H, HORIZON, pitch);
 for (const angle of [0, 0.37, Math.PI / 2, -2.4]) {
  for (const height of [-160, -64, 0, 8, 16, 64, 160]) {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const output = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
    output.fill(90);
    const output32 = new Uint32Array(output.buffer, output.byteOffset, output.byteLength / 4);
    renderGround(output32, texture32, 17.25, 500.75, sin, cos, height, inverse);
    for (let y = inverse.firstRow; y < VIEW_H; y += 3) {
      const down = (y - HORIZON) * Math.cos(pitch) - FOCAL * Math.sin(pitch);
      const forward = FOCAL * Math.cos(pitch) + (y - HORIZON) * Math.sin(pitch);
      const sampleStep = height / down;
      const u0 = Math.round((17.25 + sin * forward * sampleStep + cos * (0.5 - HALF_WIDTH) * sampleStep) * 65536);
      const v0 = Math.round((500.75 + cos * forward * sampleStep - sin * (0.5 - HALF_WIDTH) * sampleStep) * 65536);
      const du = Math.round(cos * sampleStep * 65536);
      const dv = Math.round(-sin * sampleStep * 65536);
      for (let x = 0; x < VIEW_W; x += 7) {
        // 独立した光線と地面の交点から、基準となる参照座標を求めます。
        const t = height / down;
        const exactU = 17.25 + t * (sin * forward + cos * (x + 0.5 - HALF_WIDTH));
        const exactV = 500.75 + t * (cos * forward - sin * (x + 0.5 - HALF_WIDTH));
        const u = (u0 + x * du) / 65536;
        const v = (v0 + x * dv) / 65536;
        const error = Math.max(Math.abs(u - exactU), Math.abs(v - exactV));
        maxError = Math.max(maxError, error);
        assert.ok(error < coordinateTolerance, `projection error at ${angle}, ${height}, ${x}, ${y}`);
        const src = (((Math.floor(v) & 511) * 512) + (Math.floor(u) & 511)) * 4;
        const dst = (y * VIEW_W + x) * 4;
        for (let channel = 0; channel < 3; ++channel) {
          assert.equal(output[dst + channel], texture[src + channel]);
        }
        assert.equal(output[dst + 3], 255);
        ++checked;
      }
    }
    for (let y = 0; y < inverse.firstRow; ++y) {
      assert.equal(output[y * VIEW_W * 4], 90, 'sky must stay untouched');
    }
  }
 }
}
vm.runInContext(`
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  globalThis.controls = {updateCamera, state: () => ({eyeX, eyeZ, eyeHeight, yaw, pitch, speed, rowTable})};
`, context);
const controls = context.controls;
assert.equal(controls.state().speed, 8, 'initial speed is eight');
assert.equal(controls.state().eyeHeight, 8, 'initial altitude is eight');
const press = (keys, duration = 0.5) => controls.updateCamera(duration, key => keys.includes(key));
press([87]);
assert.equal(controls.state().speed, 18, 'W changes speed by ten in half a second');
const beforeCoast = controls.state();
press([]);
assert.equal(controls.state().speed, 18, 'speed persists after release');
assert.ok(controls.state().eyeZ > beforeCoast.eyeZ, 'coasting moves forward');
const beforeStrafe = controls.state();
press([68]);
assert.ok(controls.state().eyeX > beforeStrafe.eyeX, 'D strafes right');
assert.equal(controls.state().yaw, beforeStrafe.yaw, 'D does not turn');
press([65]);
assert.equal(controls.state().eyeX, beforeStrafe.eyeX, 'A strafes left');
press([40]);
assert.ok(controls.state().pitch > 0, 'down arrow looks up');
assert.ok(controls.state().eyeHeight > beforeStrafe.eyeHeight, 'upward travel climbs');
press([38], 1);
assert.ok(controls.state().pitch < 0, 'up arrow looks down');
const beforeDescent = controls.state();
press([]);
assert.ok(controls.state().eyeHeight < beforeDescent.eyeHeight, 'downward travel descends');
press([39]);
assert.ok(controls.state().yaw > 0, 'right arrow turns right');
press([37]);
assert.equal(controls.state().yaw, 0, 'left arrow turns left');
vm.runInContext('eyeHeight = 64; pitch = -0.25; rowTable = makeRowTable(VIEW_H, HORIZON, pitch);', context);
press([83], 30);
assert.equal(controls.state().speed, -400, 'S accelerates in reverse up to the negative limit');
const beforeReverse = controls.state();
press([]);
assert.ok(controls.state().eyeZ < beforeReverse.eyeZ, 'negative speed moves backward');
assert.ok(controls.state().eyeHeight > beforeReverse.eyeHeight, 'reverse travel while looking down climbs');
press([87], 20);
assert.equal(controls.state().speed, 0, 'W brakes reverse travel to zero');
const stopped = controls.state();
press([]);
assert.equal(controls.state().eyeX, stopped.eyeX);
assert.equal(controls.state().eyeZ, stopped.eyeZ);
assert.equal(controls.state().eyeHeight, stopped.eyeHeight);
const cachedTable = controls.state().rowTable;
press([39]);
assert.equal(controls.state().rowTable, cachedTable, 'yaw reuses row table');
vm.runInContext(`
  eyeHeight = 2;
  pitch = -0.4;
  speed = 100;
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
`, context);
press([]);
assert.equal(controls.state().eyeHeight, 1, 'downward travel stops at altitude one');
assert.equal(controls.state().pitch, 0, 'reaching altitude one levels the camera');
assert.equal(controls.state().rowTable.sinPitch, 0, 'projection table is updated to horizontal');
assert.equal(controls.state().speed, 100, 'leveling preserves speed');
press([]);
assert.equal(controls.state().eyeHeight, 1, 'continued descent stays at altitude one');
press([38]);
assert.equal(controls.state().pitch, 0, 'downward input at altitude one returns to horizontal');
press([40]);
assert.ok(controls.state().eyeHeight > 1, 'upward input can climb away from altitude one');
vm.runInContext('eyeHeight = 1; pitch = -0.4; rowTable = makeRowTable(VIEW_H, HORIZON, pitch);', context);
press([83], 10);
assert.ok(controls.state().eyeHeight > 1, 'reverse travel can climb away from altitude one');
vm.runInContext('speed = 100;', context);
vm.runInContext('eyeHeight = 599; pitch = 0.4; rowTable = makeRowTable(VIEW_H, HORIZON, pitch);', context);
press([]);
assert.ok(controls.state().eyeHeight > 600, 'altitude has no upper clamp');
vm.runInContext('speed = 0;', context);
press([38], 10);
assert.equal(controls.state().pitch, -Math.PI / 2, 'up arrow reaches straight down');
assert.equal(controls.state().rowTable.firstRow, 0, 'straight down renders ground across all rows');
for (const value of controls.state().rowTable.inverse) assert.ok(Number.isFinite(value) && value > 0);
console.log(`PASS: ${checked} samples; max coordinate error ${maxError.toFixed(8)} texels`);
console.log('PASS: direction, strafe, acceleration, reverse, coasting, braking and altitude one limit');
console.log('PASS: chunked terrain and 32-bit sky initialization preserve all RGBA bytes');
vm.runInContext(`
  canvasFocused = false;
  textureRows = TEX_SIZE;
  yaw = pitch = 0;
  speed = 8;
  eyeHeight = 64;
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  globalThis.deltaTime = 16;
  globalThis.frameCount = 1;
  globalThis.performance = {now: () => 0};
  globalThis.loadPixels = () => {};
  globalThis.updatePixels = () => {};
  globalThis.pixels = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
  globalThis.keyIsDown = code => code === 87;
`, context);
const beforeBlurFrame = controls.state();
vm.runInContext('draw();', context);
assert.equal(controls.state().speed, 8, 'unfocused frame ignores W');
assert.ok(Math.abs(controls.state().eyeZ - (((beforeBlurFrame.eyeZ + 8 * 0.016) % 512 + 512) % 512)) < 1e-9,
  'unfocused frame keeps moving at current speed');
vm.runInContext('canvasFocused = true; draw();', context);
assert.ok(controls.state().speed > 8, 'focused frame accepts W');
console.log('PASS: unfocused animation keeps moving and ignores keyboard input');
vm.runInContext(`
  globalThis.resizeCanvas = (width, height) => {
    globalThis.resizedCanvas = {width, height};
    globalThis.pixels = new Uint8ClampedArray(width * height * 4);
  };
  pitch = -0.4;
  eyeHeight = 8;
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  globalThis.resolutionState = () => ({width: VIEW_W, height: VIEW_H, horizon: HORIZON,
    focal: FOCAL, sky: skyData, table: rowTable, texture: texture32, textureRows});
`, context);
const beforeResize = controls.state();
for (const width of [320, 640, 960, 1280, 1600, 1920, 640]) {
  vm.runInContext(`setResolution(${width});`, context);
  const result = context.resolutionState();
  const height = width * 9 / 16;
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.equal(context.resizedCanvas.width, width);
  assert.equal(context.resizedCanvas.height, height);
  assert.equal(result.sky.length, width * height * 4);
  assert.equal(result.table.inverse.length, height);
  assert.equal(result.horizon, height / 4);
  assert.equal(result.focal, width / 2);
  const state = controls.state();
  for (const name of ['eyeX', 'eyeZ', 'eyeHeight', 'yaw', 'pitch', 'speed']) {
    assert.equal(state[name], beforeResize[name], `resize preserves ${name}`);
  }
  const output = new Uint32Array(width * height);
  renderGround(output, texture32, 17.25, 500.75, 0, 1, 8, result.table);
  for (let y = result.table.firstRow; y < height; y += 37) {
    const down = (y - height / 4) * Math.cos(-0.4) - width / 2 * Math.sin(-0.4);
    assert.ok(Math.abs(result.table.inverse[y] - 1 / down) < 1e-12);
    const depth = 8 * ((width / 2 * Math.cos(-0.4) + (y - height / 4) * Math.sin(-0.4)) / down);
    const firstU = Math.round((17.25 + (0.5 - width / 2) * 8 / down) * 65536);
    const fixedV = Math.round((500.75 + depth) * 65536);
    const du = Math.round(8 / down * 65536);
    for (let x = 0; x < width; x += 43) {
      const src = (((fixedV >> 16) & 511) * 512) + (((firstU + x * du) >> 16) & 511);
      assert.equal(output[y * width + x], texture32[src]);
    }
  }
}
console.log('PASS: all six resolutions and camera state preservation');
