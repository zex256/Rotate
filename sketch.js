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
// 水面用パレットの範囲と更新間隔、路面用のタイル種類を定義します。
const WATER_PALETTE_START = 32 + 25 * 8;
const WATER_PALETTE_LENGTH = 8;
const WATER_FRAME_MS = 60;
const ASPHALT_FAMILIES = [11, 12, 26, 27];

// 地上データ、アニメーションの状態、描画用の表とカメラの状態を保持します。
let mapData;
let courseData;
let courseSeed = DEFAULT_COURSE_SEED;
let coursePoints = makeCoursePoints(courseSeed);
let tileData;
let palette32;
let waterAnimationMs = 0;
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

function makeCoursePoints(seed) {
  // 32bitの状態だけで乱数を作り、同じ種では同じ順序の値を取り出します。
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
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

function makeMap(data = new Uint8Array(MAP_SIZE * MAP_SIZE), startRow = 0, endRow = MAP_SIZE) {
  // コース領域を再利用し、分割生成の各フレームでは曲線を再計算しません。
  const course = courseData ?? (courseData = makeCourse());
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
