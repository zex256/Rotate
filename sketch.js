// p5.js Web Editorでは、このファイルをsketch.jsに貼り付けて実行できます。
// 描画解像度、地平線と投影の基準値を設定します。
const RESOLUTIONS = [320, 640, 960, 1280, 1600, 1920];
let VIEW_W = 640;
let VIEW_H = 360;
let HORIZON = VIEW_H / 4;
let FOCAL = VIEW_W / 2;
// 地上座標と移動量は、下位16bitを小数部とする固定小数点で扱います。
const FIXED = 65536;
const MAP_SIZE = 512;
const TILE_SIZE = 16;
const TILE_MASK = TILE_SIZE - 1;
const START_MAP_X = 91;
const START_MAP_Y = 256;
const START_YAW = Math.PI;
// ワールドの端を越えた座標は、マスクによって反対側に循環します。
const WORLD_SIZE = MAP_SIZE * TILE_SIZE;
const WORLD_FIXED = WORLD_SIZE * FIXED;
const WORLD_FIXED_MASK = WORLD_FIXED - 1;
// 描画時の座標から、マップ9bit・タイル4bit・画素内3bitを取り出します。
const COORD_FRACTION_BITS = 3;
const COORD_TILE_BITS = 4;
const COORD_MAP_BITS = 9;
const COORD_FIXED_SHIFT = 16 - COORD_FRACTION_BITS;
const COORD_MASK = 0xffff;
const COORD_MAP_MASK = (1 << COORD_MAP_BITS) - 1;
// 水面用パレットの範囲と更新間隔、路面用のタイル種類を定義します。
const WATER_PALETTE_START = 32 + 25 * 8;
const WATER_PALETTE_LENGTH = 8;
const WATER_FRAME_MS = 60;
const ASPHALT_FAMILIES = [11, 12, 26, 27];

// 地上データ、アニメーションの状態、描画用の表とカメラの状態を保持します。
let mapData;
let tileData;
let palette32;
let waterAnimationMs = 0;
let mapRows = 0;
let skyData;
let rowTable;
let eyeX = START_MAP_X * TILE_SIZE * FIXED;
let eyeZ = START_MAP_Y * TILE_SIZE * FIXED;
let yaw = START_YAW;
let pitch = 0;
let speed = 8 * FIXED;
let eyeHeight = 24 * FIXED;
let canvasFocused = false;
let renderMs = 0;

function setup() {
  // キャンバスを作り、フォーカスがあるときにキー操作を受け付けます。
  pixelDensity(1);
  const surface = createCanvas(VIEW_W, VIEW_H);
  if (document.getElementById('canvas')) surface.parent('canvas');
  surface.elt.tabIndex = 0;
  surface.elt.addEventListener('focus', () => { canvasFocused = true; });
  surface.elt.addEventListener('blur', () => { canvasFocused = false; });
  surface.elt.addEventListener('pointerdown', () => surface.elt.focus());
  surface.elt.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
    }
  });
  noSmooth();
  // パレットとタイルを生成し、マップと描画用データを用意します。
  palette32 = makePalette();
  tileData = makeTiles();
  mapData = new Uint8Array(MAP_SIZE * MAP_SIZE);
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  skyData = makeSky();
  // 解像度の変更とカメラ位置のリセットを画面の操作に結び付けます。
  document.getElementById('resolution')?.addEventListener('input', event => {
    setResolution(RESOLUTIONS[Number(event.target.value)]);
  });
  document.getElementById('reset')?.addEventListener('click', () => {
    eyeX = START_MAP_X * TILE_SIZE * FIXED;
    eyeZ = START_MAP_Y * TILE_SIZE * FIXED;
    yaw = START_YAW;
    pitch = 0;
    speed = 8 * FIXED;
    eyeHeight = 24 * FIXED;
    rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  });
}

function setResolution(width) {
  // 新しい解像度に合わせてキャンバス、投影係数、空の画像を作り直します。
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
  // RGBAバイト列と32bit配列で同じ領域を参照し、空を行単位で塗ります。
  const data = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
  const sky32 = new Uint32Array(data.buffer);
  const skyColor = new Uint8ClampedArray(4);
  const skyColor32 = new Uint32Array(skyColor.buffer);
  skyColor[3] = 255;
  // 地平線に向かって明るくなるグラデーションを作ります。
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
  // 各走査線の投影係数を先に計算し、地面が見える最初の行も記録します。
  const inverse = new Float64Array(screenHeight);
  const depthRatio = new Float64Array(screenHeight);
  const sinPitch = Math.sin(angle);
  const cosPitch = Math.cos(angle);
  let firstRow = screenHeight;
  for (let y = 0; y < screenHeight; ++y) {
    const down = (y - horizon) * cosPitch - FOCAL * sinPitch;
    if (down <= 0.000001) continue;
    if (firstRow === screenHeight) firstRow = y;
    inverse[y] = Math.round(FIXED / down);
    depthRatio[y] = Math.round((FOCAL * cosPitch + (y - horizon) * sinPitch) / down * FIXED);
  }
  return { inverse, depthRatio, firstRow, sinPitch, cosPitch };
}

function updateCamera(dt, isDown) {
  // 矢印キーで向きを変え、上下角が変化したときだけ投影表を更新します。
  const oldPitch = pitch;
  yaw += ((isDown(39) ? 1 : 0) - (isDown(37) ? 1 : 0)) * 1.5 * dt;
  pitch += ((isDown(40) ? 1 : 0) - (isDown(38) ? 1 : 0)) * 0.5 * dt;
  pitch = Math.max(-Math.PI / 2, Math.min(Math.PI * 0.39, pitch));
  if (pitch !== oldPitch) rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  // Wで加速し、Sで速度を0まで下げます。
  const acceleration = Math.round(50 * dt * FIXED);
  const braking = Math.round(75 * dt * FIXED);
  if (isDown(83)) speed = Math.max(0, speed - braking);
  else if (isDown(87)) speed = Math.min(400 * FIXED, Math.max(0, speed) + acceleration);
  else speed = Math.max(0, speed);
  // 前進とA/Dの横移動を向きに応じて地上座標に変換します。
  const forward = Math.round(speed * rowTable.cosPitch * dt);
  const side = ((isDown(68) ? 1 : 0) - (isDown(65) ? 1 : 0)) * Math.round(50 * dt * FIXED);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  eyeX = (eyeX + Math.round(sinYaw * forward) + Math.round(cosYaw * side)) & WORLD_FIXED_MASK;
  eyeZ = (eyeZ + Math.round(cosYaw * forward) - Math.round(sinYaw * side)) & WORLD_FIXED_MASK;
  // Page Up/Downで高度を変更し、下限に達したら上下角を水平に戻します。
  eyeHeight += ((isDown(33) ? 1 : 0) - (isDown(34) ? 1 : 0)) * Math.round(50 * dt * FIXED);
  if (eyeHeight <= FIXED) {
    eyeHeight = FIXED;
    if (pitch !== 0) {
      pitch = 0;
      rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
    }
  }
  return { sinYaw, cosYaw };
}

function draw() {
  // 経過時間に応じて水面用パレットの色を循環させます。
  const dt = Math.min(deltaTime, 50) / 1000;
  waterAnimationMs += deltaTime;
  if (waterAnimationMs >= WATER_FRAME_MS) {
    const steps = Math.floor(waterAnimationMs / WATER_FRAME_MS);
    waterAnimationMs -= steps * WATER_FRAME_MS;
    // 最後の色を退避し、[0]→[1]→…→[7]→[0]の順に1段ずつ移します。
    for (let step = 0; step < steps % WATER_PALETTE_LENGTH; ++step) {
      const lastColor = palette32[WATER_PALETTE_START + WATER_PALETTE_LENGTH - 1];
      for (let i = WATER_PALETTE_LENGTH - 1; i > 0; --i) {
        palette32[WATER_PALETTE_START + i] = palette32[WATER_PALETTE_START + i - 1];
      }
      palette32[WATER_PALETTE_START] = lastColor;
    }
  }
  // マップの準備完了後にカメラを更新し、描画用の向きを取得します。
  const { sinYaw, cosYaw } = mapRows === MAP_SIZE
    ? updateCamera(dt, cameraKeyIsDown)
    : { sinYaw: Math.sin(yaw), cosYaw: Math.cos(yaw) };

  // 先に空を描き、マップは1フレームにつき最大8行ずつ生成します。
  const startTime = performance.now();
  loadPixels();
  pixels.set(skyData);
  if (mapRows < MAP_SIZE) {
    const endRow = Math.min(mapRows + 8, MAP_SIZE);
    makeMap(mapData, mapRows, endRow);
    mapRows = endRow;
    updatePixels();
    const status = document.getElementById('status');
    if (status) status.textContent = `地上マップを準備しています ${Math.round(mapRows / MAP_SIZE * 100)}%`;
    return;
  }
  // 完成した地上を32bit画素として描画し、処理時間と状態を表示します。
  const output32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  renderGround(output32, mapData, tileData, palette32, eyeX, eyeZ, sinYaw, cosYaw, eyeHeight, rowTable);
  updatePixels();
  renderMs += (performance.now() - startTime - renderMs) * 0.1;
  if ((frameCount & 0xf) === 0) {
    const status = document.getElementById('status');
    if (status) status.textContent = `速度 ${(speed / FIXED).toFixed(0)} / 高度 ${(eyeHeight / FIXED).toFixed(0)} / ${frameRate().toFixed(0)} fps / 描画 ${renderMs.toFixed(2)} ms`;
  }
}

function cameraKeyIsDown(code) {
  // キャンバスにフォーカスがある場合だけキー入力を有効にします。
  return canvasFocused && keyIsDown(code);
}

function renderGround(output, map, tiles, palette, cameraX, cameraZ, sinYaw, cosYaw, height, table) {
  const halfWidth = VIEW_W / 2;
  for (let y = table.firstRow; y < VIEW_H; ++y) {
    // 固定小数点の係数で、行頭の位置と画素ごとの増分を求めます。
    const sampleStep = Math.round(height * table.inverse[y] / FIXED);
    const depth = Math.round(height * table.depthRatio[y] / FIXED);
    const left = Math.round((0.5 - halfWidth) * sampleStep);
    let u = cameraX + Math.round(sinYaw * depth) + Math.round(cosYaw * left);
    let v = cameraZ + Math.round(cosYaw * depth) - Math.round(sinYaw * left);
    const du = Math.round(cosYaw * sampleStep);
    const dv = Math.round(-sinYaw * sampleStep);
    let dst = y * VIEW_W;
    const end = dst + VIEW_W;

    // 9bitのmap座標、4bitのtile座標、3bitの画素内座標を切り出します。
    for (; dst < end; ++dst) {
      const coordX = (u >>> COORD_FIXED_SHIFT) & COORD_MASK;
      const coordY = (v >>> COORD_FIXED_SHIFT) & COORD_MASK;
      const mapX = (coordX >>> (COORD_TILE_BITS + COORD_FRACTION_BITS)) & COORD_MAP_MASK;
      const mapY = (coordY >>> (COORD_TILE_BITS + COORD_FRACTION_BITS)) & COORD_MAP_MASK;
      const tileX = (coordX >>> COORD_FRACTION_BITS) & TILE_MASK;
      const tileY = (coordY >>> COORD_FRACTION_BITS) & TILE_MASK;
      const tileNumber = map[(mapY << COORD_MAP_BITS) | mapX];
      const tileIndex = (tileNumber << 8) | (tileY << COORD_TILE_BITS) | tileX;
      output[dst] = palette[tiles[tileIndex]];
      u += du;
      v += dv;
    }
  }
}

function makePalette() {
  // 基本色と、それらを結ぶ8階調の組み合わせを定義します。
  const colors = [
    [65, 115, 175],
    [0, 0, 0], [60, 60, 60], [120, 120, 120], [210, 210, 210], [255, 255, 255],
    [96, 0, 24], [237, 28, 36], [255, 127, 39], [246, 170, 9], [249, 221, 59],
    [255, 250, 188], [14, 185, 104], [19, 230, 123], [135, 255, 94], [12, 129, 110],
    [16, 174, 166], [19, 225, 190], [96, 247, 242], [40, 80, 158], [64, 147, 228],
    [107, 80, 246], [153, 177, 251], [120, 12, 153], [170, 56, 185], [224, 159, 249],
    [203, 0, 122], [236, 31, 128], [243, 141, 169], [104, 70, 52], [149, 104, 42], [248, 178, 119]
  ];
  const ramps = [
    [12, 13], [13, 14], [29, 30], [30, 31], [9, 10], [12, 14], [29, 30], [3, 4],
    [3, 4], [19, 20], [20, 18], [18, 5], [6, 7], [19, 20], [30, 31], [12, 13],
    [12, 14], [2, 29], [29, 12], [7, 8], [20, 21], [15, 16], [23, 24], [26, 27],
    [1, 2], [19, 20], [19, 20], [19, 20]
  ];
  // RGBAの書き込みと32bit色の読み出しで、同じバッファを共有します。
  const bytes = new Uint8ClampedArray(256 * 4);
  const palette = new Uint32Array(bytes.buffer);
  for (let color = 0; color < colors.length; ++color) {
    const index = color * 4;
    bytes[index] = colors[color][0];
    bytes[index + 1] = colors[color][1];
    bytes[index + 2] = colors[color][2];
    bytes[index + 3] = 255;
  }
  // 基本色の間を補間し、パレット32番以降に8階調ずつ設定します。
  for (let ramp = 0; ramp < ramps.length; ++ramp) {
    const from = colors[ramps[ramp][0]];
    const to = colors[ramps[ramp][1]];
    for (let shade = 0; shade < 8; ++shade) {
      const index = (32 + ramp * 8 + shade) * 4;
      const amount = shade / 7;
      bytes[index] = Math.round(from[0] + (to[0] - from[0]) * amount);
      bytes[index + 1] = Math.round(from[1] + (to[1] - from[1]) * amount);
      bytes[index + 2] = Math.round(from[2] + (to[2] - from[2]) * amount);
      bytes[index + 3] = 255;
    }
  }
  return palette;
}

function makeTiles() {
  // 32種類のタイル群それぞれについて、8種類の模様を生成します。
  const ramps = [
    0, 1, 2, 3, 25, 25, 4, 5, 6, 2, 3, 7, 7, 24, 8, 0,
    18, 15, 16, 1, 12, 13, 14, 19, 8, 9, 7, 7, 21, 22, 23, 17
  ];
  const tiles = new Uint8Array(256 * TILE_SIZE * TILE_SIZE);
  for (let family = 0; family < ramps.length; ++family) {
    for (let variant = 0; variant < 8; ++variant) {
      const tileNumber = family * 8 + variant;
      for (let y = 0; y < TILE_SIZE; ++y) {
        for (let x = 0; x < TILE_SIZE; ++x) {
          const noise = (x * 17 ^ y * 31 ^ variant * 13 ^ family * 7) & 7;
          const direction = variant & 1 ? x : y;
          let shade = noise;
          let ramp = ramps[family];
          const isAsphalt = family === 11 || family === 12 || family === 26 || family === 27;
          // 草地には小さな領域ごとに向きの異なる芝目を描きます。
          if (family === 0) {
            const cellX = x >> 2;
            const cellY = y >> 2;
            let grassHash = Math.imul(cellX + variant * 17 + 1, 0x45d9f3b)
              ^ Math.imul(cellY + 1, 0x27d4eb2d);
            grassHash ^= grassHash >>> 16;
            const localX = x & 3;
            const localY = y & 3;
            const orientation = (grassHash >>> 2) & 3;
            const start = (grassHash >>> 4) & 1;
            const length = 2 + ((grassHash >>> 5) & 1);
            let blade = false;
            if ((grassHash & 3) !== 0) {
              if (orientation === 0) {
                blade = localX === ((grassHash >>> 6) & 3) && localY >= start && localY < start + length;
              } else if (orientation === 1) {
                blade = localY === ((grassHash >>> 6) & 3) && localX >= start && localX < start + length;
              } else if (orientation === 2) {
                blade = localX === ((localY + ((grassHash >>> 6) & 1)) & 3);
              } else {
                blade = localX === ((3 - localY + ((grassHash >>> 6) & 1)) & 3);
              }
            }
            shade = 3 + (noise & 1);
            if (blade) shade = 5 + ((grassHash >>> 8) & 1);
          }
          // 水面、畑、境界などはタイル群ごとの模様を付けます。
          if (family === 1 || family === 3 || family === 10 || family === 24 || family === 25) {
            shade = (noise + 2) & 7;
          }
          // 水面は共通の8色を並べ、タイル境界でも波の位相をつなげます。
          if (family === 4 || family === 5) {
            const waveOffset = Math.min(x, TILE_SIZE - x) >> 2;
            shade = (y + waveOffset) & (WATER_PALETTE_LENGTH - 1);
          }
          if (family >= 6 && family <= 9) shade = (direction & 7) < 2 ? 1 : 3 + (noise & 3);
          if (family === 10 && ((x + variant) & 15) < 2) shade = 7;
          // アスファルトは座標ごとのハッシュから3階調の粒を選びます。
          if (isAsphalt) {
            let hash = Math.imul(x + variant * 17 + 1, 0x45d9f3b)
              ^ Math.imul(y + family * 13 + 1, 0x27d4eb2d);
            hash ^= hash >>> 16;
            hash = Math.imul(hash, 0x45d9f3b);
            hash ^= hash >>> 16;
            shade = 2 + ((hash >>> ((family & 3) * 3)) % 3);
          }
          // 縁石、樹木、建物などの色と模様をタイル群ごとに決めます。
          if (family === 13) shade = 5 + (noise & 2);
          if (family === 14) shade = ((y + variant * 2) & 7) < 4 ? 7 : 1;
          if (family === 16) shade = noise < 4 ? 1 : 3;
          if (family === 17 || family === 18) {
            const dx = x - (7 + (variant & 1));
            const dy = y - (7 + ((variant >> 1) & 1));
            shade = dx * dx + dy * dy < 50 + (variant & 3) * 5 ? (noise < 4 ? 5 : 7) : 1;
          }
          if (family >= 20 && family <= 23) shade = (x + y + variant) & 7;
          if (family === 23 && x > 7) shade = Math.max(0, shade - 3);
          if (family === 24 && (x < 2 || y < 2)) shade = 7;
          // 球の中心からの距離と反射位置でガラス球を描き、周囲を路面色にします。
          if (family === 25) {
            const dx = x - 7.5;
            const dy = y - 7.5;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > 56.25) {
              ramp = 7;
              shade = 2 + (noise & 3);
            } else {
              const distance = Math.sqrt(distanceSquared);
              shade = Math.max(1, 7 - Math.floor(distance * 0.72));
              if (distance >= 6) ramp = 10;
              const highlightX = 5 + (variant & 1);
              const highlightY = 4 + ((variant >> 1) & 1);
              if (x === highlightX && y === highlightY) {
                ramp = 11;
                shade = 7;
              }
            }
          }
          const tileIndex = (tileNumber << 8) | (y << 4) | x;
          let paletteIndex = 32 + ramp * 8 + shade;
          // アスファルトの2×2画素が同じ色になった場合は最後の画素を変えます。
          if (isAsphalt && x > 0 && y > 0) {
            const left = tiles[tileIndex - 1];
            const above = tiles[tileIndex - TILE_SIZE];
            const aboveLeft = tiles[tileIndex - TILE_SIZE - 1];
            if (left === above && above === aboveLeft && paletteIndex === left) {
              shade = shade === 4 ? 3 : 4;
              paletteIndex = 32 + ramp * 8 + shade;
            }
          }
          tiles[tileIndex] = paletteIndex;
        }
      }
    }
  }
  return tiles;
}

function getCoursePulse(z, center, radius) {
  // コース上の指定位置を中心に、幅を滑らかに変える係数を求めます。
  let distance = Math.abs(z - center);
  distance = Math.min(distance, MAP_SIZE - distance);
  if (distance >= radius) return 0;
  return 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
}

function getTrackHalfWidth(z) {
  // 複数の係数を重ねて、広い区間と狭い区間を作ります。
  const halfWidth = 4 + 3.8 * getCoursePulse(z, 70, 34) + 4.5 * getCoursePulse(z, 268, 31)
    - 1.2 * getCoursePulse(z, 134, 25) - 1.4 * getCoursePulse(z, 361, 24);
  return Math.max(2.24, Math.min(6.8, halfWidth * 0.8));
}

function makeMap(data = new Uint8Array(MAP_SIZE * MAP_SIZE), startRow = 0, endRow = MAP_SIZE) {
  // 指定された行の各マスに、地形に応じたタイル番号を設定します。
  for (let z = startRow; z < endRow; ++z) {
    const riverX = 66 + 20 * Math.sin(z * Math.PI * 2 / MAP_SIZE);
    for (let x = 0; x < MAP_SIZE; ++x) {
      let family = 0;
      // 草地を基本に、畑の区画や畝を配置します。
      if (x >= 112 && x < 216 && (z < 216 || z >= 296)) {
        const field = ((x - 112) >> 5) + (z >> 6);
        const furrow = ((field & 1) ? z : x) & 7;
        const crop = field % 3;
        family = crop === 0 ? 6 : crop === 1 ? 7 : 8;
        if (furrow < 2) family = 9;
        if (((x - 112) & 31) < 2 || (z & 63) < 2) family = 10;
      }
      // 区画ごとに道、建物、境界を配置します。
      if (x >= 312 && x < 488 && ((z >= 24 && z < 208) || (z >= 312 && z < 488))) {
        const bx = (x - 312) % 44;
        const bz = (z - 4) % 46;
        const block = Math.floor((x - 312) / 44) + Math.floor(z / 46);
        family = 15;
        if (bx < 5 || bz < 5) family = 24;
        if (bx >= 13 && bx < 38 && bz >= 15 && bz < 39) family = 19;
        if (bx >= 9 && bx < 34 && bz >= 11 && bz < 35) {
          family = block % 3 === 0 ? 20 : block % 3 === 1 ? 21 : 22;
          if (bx >= 22) family = 23;
          if (bz === 11 || bx === 9 || bx === 21 || bx === 22) family = 24;
        }
      }
      // 一定の領域に、位置と大きさを変えた樹木を配置します。
      if (x < 108 || x >= 488 || (x >= 296 && x < 312)) {
        const cellX = x >> 5;
        const cellZ = z >> 5;
        const hash = (cellX * 73 ^ cellZ * 151) >>> 0;
        const tx = (x & 31) - (10 + (hash & 7));
        const tz = (z & 31) - (10 + ((hash >> 3) & 7));
        const radius = 7 + ((hash >> 6) & 3);
        if ((tx - 3) ** 2 + (tz - 4) ** 2 < radius ** 2) family = 16;
        if (tx * tx + tz * tz < radius * radius) {
          family = tx + tz < 0 ? 17 : 18;
          if ((tx + 2) ** 2 + (tz + 3) ** 2 < 9) family = 1;
        }
      }
      // 曲がる川の中心からの距離で、水面と川岸を配置します。
      const riverDistance = Math.abs(x - riverX);
      if (riverDistance < 17) family = 3;
      if (riverDistance < 13) {
        family = 4;
        if (((x + z * 2) & 31) < 2) family = 5;
      }
      // 楕円を基準に半径を周期的に変え、マップ内を周回するコースを作ります。
      const dx = x - MAP_SIZE / 2;
      const dz = z - MAP_SIZE / 2;
      const angle = (Math.atan2(dz, dx) + Math.PI * 2) % (Math.PI * 2);
      const radius = Math.sqrt(dx * dx + dz * dz);
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);
      const ellipseRadius = 1 / Math.sqrt(cosAngle * cosAngle / (165 * 165) + sinAngle * sinAngle / (185 * 185));
      const trackRadius = ellipseRadius + 22 * Math.sin(8 * angle) + 9 * Math.sin(16 * angle + Math.PI);
      const trackSlope = (176 * Math.cos(8 * angle) + 144 * Math.cos(16 * angle + Math.PI)) / trackRadius;
      const trackDistance = Math.abs(radius - trackRadius) / Math.sqrt(1 + trackSlope * trackSlope);
      const trackHalfWidth = getTrackHalfWidth(angle * MAP_SIZE / (Math.PI * 2));
      // 中心線からの距離に応じて、路面、ガラス球、縁石を配置します。
      if (trackDistance <= trackHalfWidth) {
        const asphaltHash = (Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(z + 1, 0x27d4eb2d)) >>> 0;
        family = ASPHALT_FAMILIES[asphaltHash & 3];
        if (z === 0 && (x & 1) === 0) family = 14;
      } else if (trackDistance <= trackHalfWidth + 1.5) {
        family = 25;
      } else if (trackDistance <= trackHalfWidth + 3) {
        family = 13;
      }
      // 座標に応じた模様の違いを選び、マップにタイル番号を保存します。
      const variant = ((x * 73 ^ z * 151 ^ family * 31) >>> 0) & 7;
      data[z * MAP_SIZE + x] = family * 8 + variant;
    }
  }
  return data;
}
