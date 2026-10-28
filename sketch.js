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
const DEFAULT_COURSE_SEED = 1;
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
// 水面と赤系の循環範囲・更新間隔、路面用のタイル種類を定義します。
const WATER_PALETTE_START = 32 + 25 * 8;
const WATER_PALETTE_LENGTH = 8;
const WATER_FRAME_MS = 60;
const RED_PALETTE_START = 32 + 12 * 8;
const RED_PALETTE_LENGTH = 8;
const PALETTE_CYCLES = [
  [WATER_PALETTE_START, WATER_PALETTE_LENGTH],
  [RED_PALETTE_START, RED_PALETTE_LENGTH]
];
// 球専用の8色は、反射光の白を含めずに深い青と明るい水色の間で変化させます。
const GLASS_PALETTE_START = 32 + 26 * 8;
const GLASS_PULSE_MS = WATER_FRAME_MS * 24;
const GLASS_COLORS = [
  [8, 30, 94], [10, 43, 119], [13, 58, 145], [18, 77, 169],
  [27, 98, 192], [40, 121, 213], [60, 146, 231], [88, 173, 245]
];
const GLASS_LIGHT_COLORS = [
  [10, 91, 137], [15, 116, 166], [22, 143, 193], [33, 170, 217],
  [48, 195, 235], [69, 216, 247], [104, 233, 253], [151, 246, 255]
];
const ASPHALT_FAMILIES = [11, 12, 26, 27];

// 地上データ、アニメーションの状態、描画用の表とカメラの状態を保持します。
let mapData;
let courseData;
let sceneryData;
let courseSeed = DEFAULT_COURSE_SEED;
let coursePoints = makeCoursePoints(courseSeed);
let tileData;
let palette32;
let paletteBytes;
let paletteAnimationMs = 0;
let glassPulseMs = 0;
let mapRows = 0;
let skyData;
let rowTable;
let eyeX = coursePoints[0][0] * TILE_SIZE * FIXED;
let eyeZ = coursePoints[0][1] * TILE_SIZE * FIXED;
let yaw = Math.atan2(coursePoints[1][0] - coursePoints[coursePoints.length - 1][0],
  coursePoints[1][1] - coursePoints[coursePoints.length - 1][1]);
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
  paletteBytes = new Uint8ClampedArray(palette32.buffer);
  tileData = makeTiles();
  skyData = makeSky();
  // URLに乱数種があれば、その番号のコースを最初から再現します。
  const seedText = new URLSearchParams(globalThis.location?.search ?? '').get('seed');
  const seed = seedText === null || seedText === '' ? DEFAULT_COURSE_SEED : Number(seedText);
  regenerateCourse(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? seed : DEFAULT_COURSE_SEED);
  // 解像度の変更とカメラ位置のリセットを画面の操作に結び付けます。
  document.getElementById('resolution')?.addEventListener('input', event => {
    setResolution(RESOLUTIONS[Number(event.target.value)]);
  });
  document.getElementById('reset')?.addEventListener('click', resetCamera);
  // 指定番号での再生成と、新しい番号を選ぶランダム生成を受け付けます。
  const seedInput = document.getElementById('course-seed');
  document.getElementById('course-controls')?.addEventListener('submit', event => {
    event.preventDefault();
    if (seedInput?.reportValidity()) regenerateCourse(Number(seedInput.value));
  });
  document.getElementById('random-course')?.addEventListener('click', () => {
    regenerateCourse(Math.floor(Math.random() * 4294967296));
  });
}

function resetCamera() {
  // 生成したコースの開始位置と進行方向にカメラを戻します。
  const first = coursePoints[0];
  const next = coursePoints[1];
  const previous = coursePoints[coursePoints.length - 1];
  eyeX = first[0] * TILE_SIZE * FIXED;
  eyeZ = first[1] * TILE_SIZE * FIXED;
  yaw = Math.atan2(next[0] - previous[0], next[1] - previous[1]);
  pitch = 0;
  speed = 8 * FIXED;
  eyeHeight = 24 * FIXED;
  rowTable = makeRowTable(VIEW_H, HORIZON, pitch);
  renderMs = 0;
}

function regenerateCourse(seed) {
  // 種を変更したらコースのキャッシュを破棄し、マップを先頭から生成し直します。
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return;
  courseSeed = seed;
  coursePoints = makeCoursePoints(seed);
  courseData = undefined;
  sceneryData = undefined;
  mapData = new Uint8Array(MAP_SIZE * MAP_SIZE);
  mapRows = 0;
  resetCamera();
  const seedInput = document.getElementById('course-seed');
  if (seedInput) seedInput.value = String(seed);
  const status = document.getElementById('status');
  if (status) status.textContent = '地上マップを準備しています 0%';
  // 通常のWebページでは種をURLにも保存し、blob形式のプレビューでは書き換えません。
  if (seedInput && globalThis.location && typeof globalThis.history?.replaceState === 'function') {
    const url = new URL(globalThis.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.searchParams.set('seed', String(seed));
      try {
        globalThis.history.replaceState(null, '', url);
      } catch (error) {
        // iframeなどで履歴操作が制限されていても、コース生成は続けます。
        if (error.name !== 'SecurityError') throw error;
      }
    }
  }
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
  // 経過時間に応じて水面用と赤系のパレットを、それぞれ8色の中で循環させます。
  const dt = Math.min(deltaTime, 50) / 1000;
  paletteAnimationMs += deltaTime;
  if (paletteAnimationMs >= WATER_FRAME_MS) {
    const steps = Math.floor(paletteAnimationMs / WATER_FRAME_MS);
    paletteAnimationMs -= steps * WATER_FRAME_MS;
    // 最後の色を退避し、[0]→[1]→…→[7]→[0]の順に1段ずつ移します。
    for (const [start, length] of PALETTE_CYCLES) {
      for (let step = 0; step < steps % length; ++step) {
        const lastColor = palette32[start + length - 1];
        for (let i = length - 1; i > 0; --i) {
          palette32[start + i] = palette32[start + i - 1];
        }
        palette32[start] = lastColor;
      }
    }
    // 深い青から明るい水色へ、同じ60ms刻みで補間します。反射光や路面は固定です。
    glassPulseMs = (glassPulseMs + steps * WATER_FRAME_MS) % GLASS_PULSE_MS;
    const glassBlend = 0.5 - 0.5 * Math.cos(glassPulseMs * Math.PI * 2 / GLASS_PULSE_MS);
    for (let shade = 0; shade < GLASS_COLORS.length; ++shade) {
      const index = (GLASS_PALETTE_START + shade) * 4;
      paletteBytes[index] = Math.round(GLASS_COLORS[shade][0] + (GLASS_LIGHT_COLORS[shade][0] - GLASS_COLORS[shade][0]) * glassBlend);
      paletteBytes[index + 1] = Math.round(GLASS_COLORS[shade][1] + (GLASS_LIGHT_COLORS[shade][1] - GLASS_COLORS[shade][1]) * glassBlend);
      paletteBytes[index + 2] = Math.round(GLASS_COLORS[shade][2] + (GLASS_LIGHT_COLORS[shade][2] - GLASS_COLORS[shade][2]) * glassBlend);
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
  // 空いている8パレットをガラス球専用に割り当てます。
  for (let shade = 0; shade < GLASS_COLORS.length; ++shade) {
    const index = (GLASS_PALETTE_START + shade) * 4;
    bytes[index] = GLASS_COLORS[shade][0];
    bytes[index + 1] = GLASS_COLORS[shade][1];
    bytes[index + 2] = GLASS_COLORS[shade][2];
    bytes[index + 3] = 255;
  }
  return palette;
}

function makeTiles() {
  // 32種類のタイル群それぞれについて、8種類の模様を生成します。
  const ramps = [
    0, 1, 2, 3, 25, 25, 4, 5, 6, 2, 3, 7, 7, 24, 8, 0,
    18, 15, 16, 1, 12, 13, 14, 19, 8, 26, 7, 7, 21, 22, 23, 17
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
          // 半径8の球を16×16ドットの端まで描き、白い反射光を中央寄りに置きます。
          if (family === 25) {
            const dx = x - 7.5;
            const dy = y - 7.5;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > 64) continue;
            // 外周の枠は基本色の青20番・紺19番を使い、球本体と一緒に明暗させません。
            if (distanceSquared >= 49) {
              tiles[(tileNumber << 8) | (y << 4) | x] = dy < 0 ? 20 : 19;
              continue;
            }
            const distance = Math.sqrt(distanceSquared);
            shade = Math.max(0, Math.min(7, Math.round(8 - distance - (dx + dy) * 0.16)));
            const highlightX = 5 + (variant & 1);
            const highlightY = 5 + ((variant >> 1) & 1);
            if (x === highlightX && y === highlightY) {
              ramp = 11;
              shade = 7;
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
  // 全種類の生成後に路面をコピーし、球の外側も同じ3階調の粒状模様にします。
  for (let variant = 0; variant < 8; ++variant) {
    const glassOffset = (25 * 8 + variant) << 8;
    const asphaltOffset = (ASPHALT_FAMILIES[variant & 3] * 8 + variant) << 8;
    for (let y = 0; y < TILE_SIZE; ++y) {
      for (let x = 0; x < TILE_SIZE; ++x) {
        if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 64) {
          const pixel = (y << 4) | x;
          tiles[glassOffset | pixel] = tiles[asphaltOffset | pixel];
        }
      }
    }
  }
  return tiles;
}

function makeRandom(seed) {
  // 32bitの状態だけで乱数を作り、同じ種では同じ順序の値を取り出します。
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCoursePoints(seed) {
  const random = makeRandom(seed);
  const columns = 5 + Math.floor(random() * 3);
  const rows = 5 + Math.floor(random() * 3);
  const cellCount = columns * rows;
  const target = Math.floor(cellCount * (0.7 + random() * 0.25));
  const visited = new Uint8Array(cellCount);
  const frontier = [];
  // 各区画の四隅を小さな輪にし、区画同士の接続時に一つの輪へ結合します。
  const links = Array.from({ length: cellCount * 4 }, (_, vertex) => {
    const base = vertex & ~3;
    return [base + ((vertex + 3) & 3), base + ((vertex + 1) & 3)];
  });
  const extendFrontier = cell => {
    const x = cell % columns;
    const z = Math.floor(cell / columns);
    for (const neighbor of [x > 0 ? cell - 1 : -1, x < columns - 1 ? cell + 1 : -1,
      z > 0 ? cell - columns : -1, z < rows - 1 ? cell + columns : -1]) {
      if (neighbor >= 0 && !visited[neighbor]) frontier.push([cell, neighbor]);
    }
  };
  const root = (rows - 1) * columns;
  visited[root] = 1;
  extendFrontier(root);
  let selected = 1;
  while (selected < target && frontier.length > 0) {
    // 未接続の隣接区画を乱数で選び、交差のない木状の接続を広げます。
    const index = Math.floor(random() * frontier.length);
    const [from, to] = frontier[index];
    frontier[index] = frontier[frontier.length - 1];
    frontier.pop();
    if (visited[to]) continue;
    visited[to] = 1;
    ++selected;
    let a, b, c, d;
    if (Math.floor(from / columns) === Math.floor(to / columns)) {
      const left = Math.min(from, to) * 4;
      const right = Math.max(from, to) * 4;
      [a, b, c, d] = [left + 1, left + 2, right, right + 3];
    } else {
      const top = Math.min(from, to) * 4;
      const bottom = Math.max(from, to) * 4;
      [a, b, c, d] = [top + 3, top + 2, bottom, bottom + 1];
    }
    // 向かい合う辺を開いて結び替え、分岐せずに周回できる経路にします。
    for (const [vertex, oldNeighbor, newNeighbor] of [[a, b, c], [b, a, d], [c, d, a], [d, c, b]]) {
      const neighbors = links[vertex];
      neighbors[neighbors.indexOf(oldNeighbor)] = newNeighbor;
    }
    extendFrontier(to);
  }
  const spacingX = Math.floor((MAP_SIZE - 96) / (columns * 2 - 1));
  const spacingZ = Math.floor((MAP_SIZE - 96) / (rows * 2 - 1));
  const marginX = Math.floor((MAP_SIZE - (columns * 2 - 1) * spacingX) / 2);
  const marginZ = Math.floor((MAP_SIZE - (rows * 2 - 1) * spacingZ) / 2);
  const rotation = Math.floor(random() * 4);
  const mirror = random() < 0.5;
  const points = [];
  const firstVertex = root * 4 + 3;
  let previousVertex = root * 4;
  let vertex = firstVertex;
  do {
    // 区画の輪をたどり、位置・道幅・向きを種に応じて変化させます。
    const cell = Math.floor(vertex / 4);
    const corner = vertex & 3;
    let x = marginX + ((cell % columns) * 2 + (corner === 1 || corner === 2 ? 1 : 0)) * spacingX;
    let z = marginZ + (Math.floor(cell / columns) * 2 + (corner >= 2 ? 1 : 0)) * spacingZ;
    const jitterX = Math.floor(random() * 5) - 2;
    const jitterZ = Math.floor(random() * 5) - 2;
    const width = 2.75 + Math.floor(random() * 7) * 0.25;
    const isStartEdge = vertex === firstVertex || vertex === root * 4 + 2;
    if (!isStartEdge) {
      x += jitterX;
      z += jitterZ;
    }
    if (mirror) x = MAP_SIZE - x;
    for (let turn = 0; turn < rotation; ++turn) [x, z] = [MAP_SIZE - z, x];
    points.push([x, z, isStartEdge ? 4.5 : width]);
    const nextVertex = links[vertex][0] === previousVertex ? links[vertex][1] : links[vertex][0];
    previousVertex = vertex;
    vertex = nextVertex;
  } while (vertex !== firstVertex);
  // 開始位置は最初の辺の中央にし、初期の向きを路面の進行方向に合わせます。
  const first = points.shift();
  const next = points[0];
  points.push(first);
  points.unshift([(first[0] + next[0]) / 2, (first[1] + next[1]) / 2, 4.5]);
  return points;
}

function makeCourse(points = coursePoints) {
  // 曲線の計算は生成時に一度だけ行い、路面・ガラス球・縁石の領域を保存します。
  const course = new Uint8Array(MAP_SIZE * MAP_SIZE);
  const count = points.length;
  for (let point = 0; point < count; ++point) {
    const p0 = points[(point + count - 1) % count];
    const p1 = points[point];
    const p2 = points[(point + 1) % count];
    const p3 = points[(point + 2) % count];
    const steps = Math.max(4, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2));
    let previousX = p1[0];
    let previousZ = p1[1];
    let previousWidth = p1[2];
    for (let step = 1; step <= steps; ++step) {
      // Catmull-Rom曲線で通過点を滑らかにつなぎ、約2マスごとに線分へ分割します。
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const nextX = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t
        + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
        + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const nextZ = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      const nextWidth = p1[2] + (p2[2] - p1[2]) * t;
      const margin = Math.max(previousWidth, nextWidth) + 3;
      const minX = Math.max(0, Math.floor(Math.min(previousX, nextX) - margin));
      const maxX = Math.min(MAP_SIZE - 1, Math.ceil(Math.max(previousX, nextX) + margin));
      const minZ = Math.max(0, Math.floor(Math.min(previousZ, nextZ) - margin));
      const maxZ = Math.min(MAP_SIZE - 1, Math.ceil(Math.max(previousZ, nextZ) + margin));
      const dx = nextX - previousX;
      const dz = nextZ - previousZ;
      const lengthSquared = dx * dx + dz * dz;
      // 線分付近のマスだけを調べ、道幅の変化を補間して各領域を塗ります。
      for (let z = minZ; z <= maxZ; ++z) {
        for (let x = minX; x <= maxX; ++x) {
          const px = x + 0.5 - previousX;
          const pz = z + 0.5 - previousZ;
          const along = lengthSquared > 0
            ? Math.max(0, Math.min(1, (px * dx + pz * dz) / lengthSquared)) : 0;
          const offsetX = px - along * dx;
          const offsetZ = pz - along * dz;
          const distanceSquared = offsetX * offsetX + offsetZ * offsetZ;
          const width = previousWidth + (nextWidth - previousWidth) * along;
          const layer = distanceSquared <= width * width ? 1
            : distanceSquared <= (width + 1.5) ** 2 ? 2
            : distanceSquared <= (width + 3) ** 2 ? 3 : 0;
          const index = z * MAP_SIZE + x;
          if (layer && (course[index] === 0 || layer < course[index])) course[index] = layer;
        }
      }
      previousX = nextX;
      previousZ = nextZ;
      previousWidth = nextWidth;
    }
  }
  return course;
}

function makeLakeSpans(random, size) {
  // 複数の波を重ねた輪郭で、入り江や半島のある不規則な湖を作ります。
  const radiusX = size * (0.85 + random() * 0.35);
  const radiusZ = size * (0.6 + random() * 0.4);
  const rotation = random() * Math.PI * 2;
  const phases = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const points = [];
  for (let i = 0; i < 64; ++i) {
    const angle = i * Math.PI * 2 / 64;
    const radius = 0.9 + 0.3 * Math.sin(3 * angle + phases[0])
      + 0.2 * Math.sin(5 * angle + phases[1]) + 0.12 * Math.sin(7 * angle + phases[2]);
    const x = radiusX * radius * Math.cos(angle);
    const z = radiusZ * radius * Math.sin(angle);
    points.push([x * cos - z * sin, x * sin + z * cos]);
  }
  // 輪郭を走査線ごとの塗りつぶし区間に変換し、配置候補の判定にも再利用します。
  const minZ = Math.floor(Math.min(...points.map(point => point[1])));
  const maxZ = Math.ceil(Math.max(...points.map(point => point[1])));
  const spans = [];
  for (let z = minZ; z <= maxZ; ++z) {
    const crossings = [];
    const sampleZ = z + 0.5;
    for (let i = 0; i < points.length; ++i) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a[1] > sampleZ) !== (b[1] > sampleZ)) {
        crossings.push(a[0] + (sampleZ - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const left = Math.ceil(crossings[i] - 0.5);
      const right = Math.floor(crossings[i + 1] - 0.5);
      if (left <= right) spans.push([z, left, right]);
    }
  }
  return spans;
}

function isSceneryAreaFree(data, course, x, z, width, height, avoidCourse = true) {
  // 建物や樹木の全体が乾いた空き地に収まるかを調べます。
  if (x < 2 || z < 2 || x + width > MAP_SIZE - 2 || z + height > MAP_SIZE - 2) return false;
  for (let row = z; row < z + height; ++row) {
    for (let column = x; column < x + width; ++column) {
      const index = row * MAP_SIZE + column;
      if (data[index] !== 0 || (avoidCourse && course[index] !== 0)) return false;
    }
  }
  return true;
}

function makeScenery(seed, course) {
  // 地上物専用の乱数列を使い、配置を変えてもコースの形は変えません。
  const random = makeRandom((seed ^ 0xa511e9b3) >>> 0);
  const data = new Uint8Array(MAP_SIZE * MAP_SIZE);
  const riverPhase = random() * Math.PI * 2;
  const ripplePhase = random() * Math.PI * 2;
  const riverAmplitude = 130 + random() * 25;
  const rippleAmplitude = 25 + random() * 15;
  for (let z = 0; z < MAP_SIZE; ++z) {
    // 大小の蛇行を重ねて川を左右に振り、傾きに応じて川幅を補正します。
    const riverAngle = z * Math.PI * 2 / MAP_SIZE;
    const riverX = MAP_SIZE / 2 + riverAmplitude * Math.sin(riverAngle + riverPhase)
      + rippleAmplitude * Math.sin(2 * riverAngle + ripplePhase);
    const riverSlope = (riverAmplitude * Math.cos(riverAngle + riverPhase)
      + 2 * rippleAmplitude * Math.cos(2 * riverAngle + ripplePhase)) * Math.PI * 2 / MAP_SIZE;
    const riverNormalScale = Math.sqrt(1 + riverSlope * riverSlope);
    for (let x = 0; x < MAP_SIZE; ++x) {
      const riverDistance = Math.abs(x - riverX) / riverNormalScale;
      if (riverDistance < 17) data[z * MAP_SIZE + x] = 3;
      if (riverDistance < 13) data[z * MAP_SIZE + x] = ((x + z * 2) & 31) < 2 ? 5 : 4;
    }
  }
  // 大きな湖から小さな池まで、既存の水面とつながらない場所へ配置します。
  for (const size of [68, 46, 30, 18, 10]) {
    let spans;
    let minX, maxX, minZ, maxZ;
    for (let attempt = 0; attempt < 160; ++attempt) {
      if (attempt % 40 === 0) {
        spans = makeLakeSpans(random, size * 0.82 ** Math.floor(attempt / 40));
        minX = Math.min(...spans.map(span => span[1]));
        maxX = Math.max(...spans.map(span => span[2]));
        minZ = spans[0][0];
        maxZ = spans[spans.length - 1][0];
      }
      const lakeX = 4 - minX + Math.floor(random() * (MAP_SIZE - 8 - maxX + minX));
      const lakeZ = 4 - minZ + Math.floor(random() * (MAP_SIZE - 8 - maxZ + minZ));
      let free = true;
      for (const [row, left, right] of spans) {
        for (let x = left; x <= right; ++x) {
          if (data[(lakeZ + row) * MAP_SIZE + lakeX + x] !== 0) {
            free = false;
            break;
          }
        }
        if (!free) break;
      }
      if (!free) continue;
      for (const [row, left, right] of spans) {
        const z = lakeZ + row;
        for (let x = lakeX + left; x <= lakeX + right; ++x) {
          data[z * MAP_SIZE + x] = ((x + z * 2) & 31) < 2 ? 5 : 4;
        }
      }
      // 湖岸だけを広げて砂地を作り、深く切れ込んだ水際の形は残します。
      for (const [row, left, right] of spans) {
        const z = lakeZ + row;
        for (let x = lakeX + left; x <= lakeX + right; ++x) {
          const index = z * MAP_SIZE + x;
          if (data[index - 1] >= 4 && data[index + 1] >= 4
            && data[index - MAP_SIZE] >= 4 && data[index + MAP_SIZE] >= 4) continue;
          for (let dz = -3; dz <= 3; ++dz) {
            for (let dx = -3; dx <= 3; ++dx) {
              if (dx * dx + dz * dz > 9) continue;
              const shore = (z + dz) * MAP_SIZE + x + dx;
              if (data[shore] === 0) data[shore] = 3;
            }
          }
        }
      }
      break;
    }
  }
  // 畑は区画の位置・大きさ・作物・畝の向きを変えて配置します。
  const fieldCount = 8 + Math.floor(random() * 4);
  for (let field = 0; field < fieldCount; ++field) {
    const width = 24 + Math.floor(random() * 40);
    const height = 24 + Math.floor(random() * 48);
    const crop = 6 + Math.floor(random() * 3);
    const vertical = random() < 0.5;
    const furrowGap = 6 + Math.floor(random() * 4);
    for (let attempt = 0; attempt < 64; ++attempt) {
      const x = 4 + Math.floor(random() * (MAP_SIZE - width - 8));
      const z = 4 + Math.floor(random() * (MAP_SIZE - height - 8));
      if (!isSceneryAreaFree(data, course, x, z, width, height, false)) continue;
      for (let dz = 0; dz < height; ++dz) {
        for (let dx = 0; dx < width; ++dx) {
          const border = dx === 0 || dz === 0 || dx === width - 1 || dz === height - 1;
          data[(z + dz) * MAP_SIZE + x + dx] = border ? 10
            : (vertical ? dx : dz) % furrowGap === 0 ? 9 : crop;
        }
      }
      break;
    }
  }
  // 集落ごとに建物を散らし、建物全体が水面やコースを避けるようにします。
  const townCount = 3 + Math.floor(random() * 3);
  for (let town = 0; town < townCount; ++town) {
    let townX, townZ;
    for (let attempt = 0; attempt < 32; ++attempt) {
      townX = 32 + Math.floor(random() * (MAP_SIZE - 64));
      townZ = 32 + Math.floor(random() * (MAP_SIZE - 64));
      if (data[townZ * MAP_SIZE + townX] === 0 && course[townZ * MAP_SIZE + townX] === 0) break;
    }
    const houseCount = 8 + Math.floor(random() * 7);
    for (let house = 0; house < houseCount; ++house) {
      const width = 12 + Math.floor(random() * 11);
      const height = 12 + Math.floor(random() * 13);
      const roof = 20 + Math.floor(random() * 3);
      for (let attempt = 0; attempt < 12; ++attempt) {
        const x = Math.round(townX + (random() - 0.5) * 140 - width / 2);
        const z = Math.round(townZ + (random() - 0.5) * 140 - height / 2);
        if (!isSceneryAreaFree(data, course, x, z, width, height)) continue;
        for (let dz = 0; dz < height; ++dz) {
          for (let dx = 0; dx < width; ++dx) {
            let family = dx === 0 || dz === 0 || dx === width - 1 || dz === height - 1 ? 24 : 15;
            if (dx >= 2 && dx < width - 2 && dz >= 2 && dz < height - 3) {
              family = dx >= Math.floor(width * 0.6) ? 23 : roof;
              if (dx === 2 || dz === 2) family = 24;
            }
            data[(z + dz) * MAP_SIZE + x + dx] = family;
          }
        }
        break;
      }
    }
  }
  // 森の中心も乱数で選び、まとまりと疎らな樹木を混ぜます。
  const forests = Array.from({ length: 6 + Math.floor(random() * 5) }, () => [
    16 + random() * (MAP_SIZE - 32), 16 + random() * (MAP_SIZE - 32), 24 + random() * 42
  ]);
  const treeAttempts = 500 + Math.floor(random() * 250);
  for (let tree = 0; tree < treeAttempts; ++tree) {
    const forest = forests[Math.floor(random() * forests.length)];
    const scattered = random() < 0.2;
    const x = Math.round(scattered ? random() * MAP_SIZE : forest[0] + (random() - 0.5) * forest[2] * 2);
    const z = Math.round(scattered ? random() * MAP_SIZE : forest[1] + (random() - 0.5) * forest[2] * 2);
    const radius = 3 + Math.floor(random() * 6);
    if (!isSceneryAreaFree(data, course, x - radius, z - radius, radius * 2 + 4, radius * 2 + 4)) continue;
    for (let dz = -radius; dz <= radius + 3; ++dz) {
      for (let dx = -radius; dx <= radius + 3; ++dx) {
        const index = (z + dz) * MAP_SIZE + x + dx;
        if ((dx - 2) ** 2 + (dz - 3) ** 2 < radius * radius) data[index] = 16;
        if (dx * dx + dz * dz < radius * radius) {
          data[index] = dx + dz < 0 ? 17 : 18;
          if ((dx + 1) ** 2 + (dz + 1) ** 2 < radius * radius / 9) data[index] = 1;
        }
      }
    }
  }
  return data;
}

function makeMap(data = new Uint8Array(MAP_SIZE * MAP_SIZE), startRow = 0, endRow = MAP_SIZE) {
  // コースと地上物は一度だけ生成し、分割生成の各フレームでは同じ配置を参照します。
  const course = courseData ?? (courseData = makeCourse());
  const scenery = sceneryData ?? (sceneryData = makeScenery(courseSeed, course));
  for (let z = startRow; z < endRow; ++z) {
    for (let x = 0; x < MAP_SIZE; ++x) {
      let family = scenery[z * MAP_SIZE + x];
      // 生成済みのコース領域に従い、路面、ガラス球、縁石を配置します。
      const trackLayer = course[z * MAP_SIZE + x];
      if (trackLayer === 1) {
        const asphaltHash = (Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(z + 1, 0x27d4eb2d)) >>> 0;
        family = ASPHALT_FAMILIES[asphaltHash & 3];
      } else if (trackLayer === 2) {
        family = 25;
      } else if (trackLayer === 3) {
        family = 13;
      }
      // 座標に応じた模様の違いを選び、マップにタイル番号を保存します。
      const variant = ((x * 73 ^ z * 151 ^ family * 31) >>> 0) & 7;
      data[z * MAP_SIZE + x] = family * 8 + variant;
    }
  }
  return data;
}
