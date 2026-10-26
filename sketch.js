// p5.js Web Editorでは、このファイルをsketch.jsに貼り付けて実行できます。
const RESOLUTIONS = [320, 640, 960, 1280, 1600, 1920];
let VIEW_W = 640;
let VIEW_H = 360;
let HORIZON = VIEW_H / 4;
let FOCAL = VIEW_W / 2;
const TEX_SIZE = 512;
const TEX_MASK = TEX_SIZE - 1;
const FIXED = 65536;

let texture32;
let textureData;
let textureRows = 0;
let skyData;
let rowTable;
let eyeX = 256;
let eyeZ = 256;
let yaw = 0;
let pitch = 0;
let speed = 8;
let eyeHeight = 8;
let canvasFocused = false;
let renderMs = 0;

function setup() {
  pixelDensity(1);
  const surface = createCanvas(VIEW_W, VIEW_H);
  if (document.getElementById('canvas')) surface.parent('canvas');
  surface.elt.tabIndex = 0;
  surface.elt.addEventListener('focus', () => { canvasFocused = true; });
  surface.elt.addEventListener('blur', () => { canvasFocused = false; });
  surface.elt.addEventListener('pointerdown', () => surface.elt.focus());
  surface.elt.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
      event.preventDefault();
    }
  });
  noSmooth();
  textureData = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 4);
  texture32 = new Uint32Array(textureData.buffer, textureData.byteOffset, textureData.byteLength / 4);
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  skyData = makeSky();
  document.getElementById('resolution')?.addEventListener('input', event => {
    setResolution(RESOLUTIONS[Number(event.target.value)]);
  });
  document.getElementById('reset')?.addEventListener('click', () => {
    eyeX = eyeZ = 256;
    yaw = 0;
    pitch = 0;
    speed = 8;
    eyeHeight = 8;
    rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  });
}

function setResolution(width) {
  if (!RESOLUTIONS.includes(width) || width === VIEW_W) return;
  VIEW_W = width;
  VIEW_H = width * 9 / 16;
  HORIZON = VIEW_H / 4;
  FOCAL = VIEW_W / 2;
  resizeCanvas(VIEW_W, VIEW_H, true);
  noSmooth();
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  skyData = makeSky();
  renderMs = 0;
  const label = document.getElementById('resolution-value');
  if (label) label.textContent = `${VIEW_W} × ${VIEW_H}`;
}

function makeSky() {
  const data = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
  const sky32 = new Uint32Array(data.buffer);
  const skyColor = new Uint8ClampedArray(4);
  const skyColor32 = new Uint32Array(skyColor.buffer);
  skyColor[3] = 255;
  for (let y = 0; y < VIEW_H; ++y) {
    const t = Math.min(y / HORIZON, 1);
    skyColor[0] = 65 + 85 * t;
    skyColor[1] = 115 + 75 * t;
    skyColor[2] = 175 + 45 * t;
    sky32.fill(skyColor32[0], y * VIEW_W, (y + 1) * VIEW_W);
  }
  return data;
}

// 上下の向きや画面サイズを変更した場合だけ、この表を作り直します。
function makeRowTable(screenHeight, horizon, angle = 0) {
  const inverse = new Float64Array(screenHeight);
  const depthRatio = new Float64Array(screenHeight);
  const sinPitch = Math.sin(angle);
  const cosPitch = Math.cos(angle);
  let firstRow = screenHeight;
  for (let y = 0; y < screenHeight; ++y) {
    const down = (y - horizon) * cosPitch - FOCAL * sinPitch;
    if (down <= 0.000001) continue;
    if (firstRow === screenHeight) firstRow = y;
    inverse[y] = 1 / down;
    depthRatio[y] = (FOCAL * cosPitch + (y - horizon) * sinPitch) * inverse[y];
  }
  return { inverse, depthRatio, firstRow, sinPitch, cosPitch };
}

function updateCamera(dt, isDown) {
  const oldPitch = pitch;
  yaw += ((isDown(39) ? 1 : 0) - (isDown(37) ? 1 : 0)) * dt;
  pitch += ((isDown(40) ? 1 : 0) - (isDown(38) ? 1 : 0)) * 0.5 * dt;
  pitch = Math.max(-Math.PI / 2, Math.min(Math.PI * 0.39, pitch));
  if (pitch !== oldPitch) rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  speed += ((isDown(87) ? 1 : 0) - (isDown(83) ? 1 : 0)) * 20 * dt;
  speed = Math.max(-400, Math.min(400, speed));
  const forward = speed * rowTable.cosPitch * dt;
  const side = ((isDown(68) ? 1 : 0) - (isDown(65) ? 1 : 0)) * 100 * dt;
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  eyeX += sinYaw * forward + cosYaw * side;
  eyeZ += cosYaw * forward - sinYaw * side;
  eyeHeight += speed * rowTable.sinPitch * dt;
  if (eyeHeight <= 1) {
    eyeHeight = 1;
    if (pitch !== 0) {
      pitch = 0;
      rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
    }
  }
  return { sinYaw, cosYaw };
}

function draw() {
  const dt = Math.min(deltaTime, 50) / 1000;
  const { sinYaw, cosYaw } = textureRows === TEX_SIZE
    ? updateCamera(dt, cameraKeyIsDown)
    : { sinYaw: Math.sin(yaw), cosYaw: Math.cos(yaw) };
  eyeX = ((eyeX % TEX_SIZE) + TEX_SIZE) % TEX_SIZE;
  eyeZ = ((eyeZ % TEX_SIZE) + TEX_SIZE) % TEX_SIZE;

  const startTime = performance.now();
  loadPixels();
  pixels.set(skyData);
  if (textureRows < TEX_SIZE) {
    const endRow = Math.min(textureRows + 8, TEX_SIZE);
    makeTexture(textureData, textureRows, endRow);
    textureRows = endRow;
    updatePixels();
    const status = document.getElementById('status');
    if (status) status.textContent = `地上マップを準備しています ${Math.round(textureRows / TEX_SIZE * 100)}%`;
    return;
  }
  const output32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  renderGround(output32, texture32, eyeX, eyeZ, sinYaw, cosYaw, eyeHeight, rowTable);
  updatePixels();
  renderMs += (performance.now() - startTime - renderMs) * 0.1;
  if ((frameCount & 0xf) === 0) {
    const status = document.getElementById('status');
    if (status) status.textContent = `速度 ${speed.toFixed(0)} / 高度 ${eyeHeight.toFixed(0)} / ${frameRate().toFixed(0)} fps / 描画 ${renderMs.toFixed(2)} ms`;
  }
}

function cameraKeyIsDown(code) {
  return canvasFocused && keyIsDown(code);
}

function renderGround(output, tex, cameraX, cameraZ, sinYaw, cosYaw, height, table) {
  const halfWidth = VIEW_W / 2;
  for (let y = table.firstRow; y < VIEW_H; ++y) {
    // 参照間隔と前方距離を分け、平面の透視投影を求めます。
    const sampleStep = height * table.inverse[y];
    const depth = height * table.depthRatio[y];
    const left = (0.5 - halfWidth) * sampleStep;
    let u = Math.round((cameraX + sinYaw * depth + cosYaw * left) * FIXED);
    let v = Math.round((cameraZ + cosYaw * depth - sinYaw * left) * FIXED);
    const du = Math.round(cosYaw * sampleStep * FIXED);
    const dv = Math.round(-sinYaw * sampleStep * FIXED);
    let dst = y * VIEW_W;
    const end = dst + VIEW_W;

    // 画素ごとの乗除算・三角関数・p5.jsのget()/set()は不要です。
    for (; dst < end; ++dst) {
      const src = (((v >> 16) & TEX_MASK) << 9) | ((u >> 16) & TEX_MASK);
      output[dst] = tex[src];
      u += du;
      v += dv;
    }
  }
}

function makeTexture(data = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 4), startRow = 0, endRow = TEX_SIZE) {
  for (let z = startRow; z < endRow; ++z) {
    const riverX = 66 + 20 * Math.sin(z * Math.PI * 2 / TEX_SIZE);
    for (let x = 0; x < TEX_SIZE; ++x) {
      const grain = ((x * 17 ^ z * 31 ^ (x * z)) & 7) - 3;
      let color = [94 + grain, 144 + grain, 76 + grain];

      // 畑は区画ごとに作物と畝の向きを変えます。
      if (x >= 112 && x < 216 && (z < 216 || z >= 296)) {
        const field = ((x - 112) >> 5) + (z >> 6);
        const furrow = ((field & 1) ? z : x) & 7;
        const crop = field % 3;
        color = crop === 0 ? [180, 157, 72] : crop === 1 ? [130, 153, 63] : [153, 111, 69];
        if (furrow < 2) color = [105, 89, 49];
        if (((x - 112) & 31) < 2 || (z & 63) < 2) color = [195, 177, 123];
      }

      // 集落の屋根・庭・路地・影を平面の模様として描きます。
      if (x >= 312 && x < 488 && ((z >= 24 && z < 208) || (z >= 312 && z < 488))) {
        const bx = (x - 312) % 44;
        const bz = (z - 4) % 46;
        const block = Math.floor((x - 312) / 44) + Math.floor(z / 46);
        color = [136 + grain, 159 + grain, 99 + grain];
        if (bx < 5 || bz < 5) color = [188, 181, 158];
        if (bx >= 13 && bx < 38 && bz >= 15 && bz < 39) color = [65, 86, 65];
        if (bx >= 9 && bx < 34 && bz >= 11 && bz < 35) {
          color = block % 3 === 0 ? [177, 89, 63] : block % 3 === 1 ? [83, 111, 139] : [199, 170, 103];
          if (bx >= 22) color = color.map(value => value - 28);
          if (bz === 11 || bx === 9) color = [226, 207, 166];
          if (bx === 21 || bx === 22) color = [222, 194, 146];
        }
      }

      // 川沿いと集落の外側に、位置と大きさの異なる木を配置します。
      if (x < 108 || x >= 488 || (x >= 296 && x < 312)) {
        const cellX = x >> 5;
        const cellZ = z >> 5;
        const hash = (cellX * 73 ^ cellZ * 151) >>> 0;
        const tx = (x & 31) - (10 + (hash & 7));
        const tz = (z & 31) - (10 + ((hash >> 3) & 7));
        const radius = 7 + ((hash >> 6) & 3);
        if ((tx - 3) ** 2 + (tz - 4) ** 2 < radius ** 2) color = [57, 104, 59];
        if (tx * tx + tz * tz < radius * radius) {
          color = tx + tz < 0 ? [60, 125, 65] : [40, 92, 54];
          if ((tx + 2) ** 2 + (tz + 3) ** 2 < 9) color = [91, 151, 74];
        }
      }

      const riverDistance = Math.abs(x - riverX);
      if (riverDistance < 17) color = [194, 185, 134];
      if (riverDistance < 13) {
        color = [48, 126 + ((x + z) & 7), 164];
        if (((x + z * 2) & 31) < 2) color = [108, 181, 195];
      }

      const verticalRoad = x >= 232 && x < 280;
      const horizontalRoad = z >= 232 && z < 280;
      if ((x >= 228 && x < 284) || (z >= 228 && z < 284)) color = [187, 183, 166];
      if (verticalRoad || horizontalRoad) {
        color = [58 + (grain & 1), 65 + (grain & 1), 73 + (grain & 1)];
        if (verticalRoad && !horizontalRoad) {
          if (x < 234 || x >= 278) color = [240, 233, 206];
          if (x >= 255 && x < 257 && (z & 31) < 18) color = [244, 206, 78];
        }
        if (horizontalRoad && !verticalRoad) {
          if (z < 234 || z >= 278) color = [240, 233, 206];
          if (z >= 255 && z < 257 && (x & 31) < 18) color = [244, 206, 78];
        }
        if (verticalRoad && ((z >= 220 && z < 230) || (z >= 282 && z < 292)) && (x & 7) < 4) color = [240, 233, 206];
        if (horizontalRoad && ((x >= 220 && x < 230) || (x >= 282 && x < 292)) && (z & 7) < 4) color = [240, 233, 206];
      }
      const i = (z * TEX_SIZE + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return data;
}
