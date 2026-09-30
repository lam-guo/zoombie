import './style.css';
import { GameAudio } from './game/audio';
import { Simulation } from './game/simulation';
import { World } from './game/world';
import {
  LEVELS,
  WEAPONS,
  WEAPON_IDS,
  RULES,
  levelTotal,
  type GameInput,
  type WeaponId,
} from './game/types';

const icon = (name: 'sound' | 'pause' | 'crosshair' | 'arrow' | 'shield') => {
  const paths = {
    sound: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    crosshair: '<circle cx="12" cy="12" r="6"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="M12 8v8m-4-4h8"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" aria-label="最后防线首页">
      <span class="brand-mark"><i></i><i></i><i></i></span>
      <span>LAST LINE<small>最后防线</small></span>
    </a>
    <div class="mission-tag"><span class="live-dot"></span> 隔离区防卫行动 <span class="slash">/</span> 五关战役</div>
    <div class="toolbar">
      <button class="icon-button" id="sound" aria-label="关闭声音" aria-pressed="false" title="声音">${icon('sound')}</button>
      <button class="icon-button" id="pause" aria-label="暂停游戏" title="暂停 · Esc" disabled>${icon('pause')}</button>
    </div>
  </header>

  <main class="arena" id="arena" aria-label="3D 战斗场地">
    <canvas id="game" aria-label="鼠标移动瞄准，按住左键开火" tabindex="0"></canvas>
    <div class="scene-vignette"></div>
    <div class="arena-label"><span class="bracket">⌜</span><span id="level-label">01 / 05 · 外围接触<small>NORTH CHECKPOINT · 07</small></span></div>
    <div class="area-status"><span class="live-dot"></span><span id="status">等待部署</span></div>

    <div class="hud" id="hud" hidden>
      <div class="health-block">
        <div class="hud-label">${icon('shield')} 生命值 <strong><span id="hp">100</span><span class="dim"> / 100</span></strong></div>
        <div class="health-track" role="progressbar" aria-label="生命值" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i id="health-fill"></i></div>
      </div>
      <div class="hud-metrics"><div><span>本关击杀</span><strong id="kills">00</strong></div><div><span>本关用时</span><strong id="time">00:00</strong></div></div>
    </div>
    <div class="level-progress" id="level-progress" hidden>
      <div><span id="level-hint"></span><strong id="remaining"></strong></div>
      <div class="level-track"><i id="level-fill"></i></div>
      <small id="wave-status"></small>
    </div>

    <section class="intro" id="intro" aria-labelledby="intro-title">
      <div class="eyebrow"><span></span> HOLD YOUR GROUND</div>
      <h1 id="intro-title">最后<span>防线。</span></h1>
      <p class="intro-copy">五道防线，三把武器。<br>选好目标，留好弹药，撑过最后一波。</p>
      <div class="intro-rule"></div>
      <div class="control-row"><span class="mouse-icon"></span><span>移动鼠标<span class="control-note">瞄准目标</span></span></div>
      <div class="control-row"><span class="mouse-icon pressed"></span><span>按住左键<span class="control-note">持续开火</span></span></div>
      <div class="control-row keyboard-row"><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 切枪</span><span><kbd>R</kbd> 装填</span></div>
      <button class="primary-button" id="start">进入战斗 ${icon('arrow')}</button>
      <div class="intro-meta"><span>四类敌人</span><i></i><span>每关 1–3 分钟</span><i></i><span>空仓自动装填</span></div>
    </section>

    <div class="reticle" id="reticle" hidden><i></i><i></i><i></i><i></i><b></b></div>
    <div class="damage-vignette" id="damage"></div>

    <div class="modal-wrap" id="pause-panel" hidden>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <div class="eyebrow">TAKE A BREATH</div><h2 id="pause-title">行动暂停</h2>
        <p>阵地已冻结。准备好后，继续防守。</p>
        <button class="primary-button" id="resume">继续战斗 ${icon('arrow')}</button>
        <button class="text-button" id="pause-restart">重试本关</button>
      </section>
    </div>
    <div class="modal-wrap" id="over-panel" hidden>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="over-title">
        <div class="eyebrow">THE LINE HAS FALLEN</div><h2 id="over-title">防线失守</h2>
        <p id="failure-copy">调整武器，再守住这道防线。</p>
        <div class="result-grid"><div><span>击杀僵尸</span><strong id="result-kills">0</strong></div><div><span>生存时间</span><strong id="result-time">00:00</strong></div><div><span>命中率</span><strong id="result-accuracy">0%</strong></div></div>
        <button class="primary-button" id="restart">重试本关 ${icon('arrow')}</button>
        <div class="keyboard-hint">或按 <kbd>R</kbd> 重试 · 生命与弹匣补满</div>
      </section>
    </div>
    <div class="modal-wrap" id="clear-panel" hidden>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="clear-title">
        <div class="eyebrow">PERIMETER SECURED</div><h2 id="clear-title">关卡完成</h2>
        <p id="clear-summary"></p>
        <div class="result-grid"><div><span>本关击杀</span><strong id="clear-kills">0</strong></div><div><span>本关用时</span><strong id="clear-time">00:00</strong></div><div><span>命中率</span><strong id="clear-accuracy">0%</strong></div></div>
        <p id="next-hint"></p>
        <button class="primary-button" id="next-level">下一关 ${icon('arrow')}</button>
        <button class="primary-button" id="campaign-restart" hidden>重新出击 ${icon('arrow')}</button>
        <div class="keyboard-hint" id="supply-note">下一关补满生命与所有弹匣</div>
      </section>
    </div>
    <div class="modal-wrap" id="error-panel" hidden>
      <section class="modal" role="alert"><div class="eyebrow">RENDERER UNAVAILABLE</div><h2>无法启动 3D 场景</h2><p>请使用支持 WebGL 2 的浏览器，并开启硬件加速后刷新页面。</p></section>
    </div>

    <div class="scene-bottom"><span class="coordinates">ZONE 07 <i></i> <span id="enemy-intel">游荡者 · 普通目标</span></span><span id="threat" hidden>场上威胁 <b id="enemies">0</b></span></div>
  </main>

  <footer class="bottom-bar">
    <div class="weapon-picker" role="group" aria-label="选择武器">
      ${WEAPON_IDS.map((id, index) => `<button class="weapon-card" id="weapon-${id}" aria-label="${['步枪', '狙击枪', '霰弹枪'][index]}" aria-pressed="${index === 0}" disabled style="--weapon-color:${WEAPONS[id].color}"><span><kbd>${index + 1}</kbd>${WEAPONS[id].name}</span><small>${WEAPONS[id].description}</small><b id="mag-${id}">${WEAPONS[id].magazine}</b></button>`).join('')}
    </div>
    <div class="ammo-panel">
      <div class="ammo"><strong id="ammo-count">30</strong><span>/ <b id="ammo-capacity">30</b><small>备弹充足</small></span></div>
      <button id="reload" class="reload-button" aria-label="装填弹匣" disabled><span id="reload-label">装填</span><kbd>R</kbd></button>
      <div class="reload-track" role="progressbar" aria-label="装填进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="reload-fill"></i></div>
    </div>
  </footer>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const simulation = new Simulation();
const audio = new GameAudio();
const input: GameInput = { aim: { x: 0, z: -5 }, firing: false };
let world: World;
try {
  world = new World(canvas);
} catch (error) {
  $('intro').hidden = true;
  $('error-panel').hidden = false;
  $('status').textContent = '场景不可用';
  throw error;
}

let lastPhase = simulation.state.phase;
let pointer: { x: number; y: number } | null = null;
let previous = performance.now();
let uiAccumulator = 0;
let damageTime = 0;
let frames = 0;
let frameTime = 0;
let fps = 0;

function clearInput(): void {
  input.firing = false;
  $('reticle').hidden = true;
}

function begin(action: 'start' | 'retry' | 'nextLevel' = 'start'): void {
  audio.unlock();
  clearInput();
  world.clearEffects();
  damageTime = 0;
  $('damage').style.opacity = '0';
  input.aim = { x: 0, z: -5 };
  simulation[action]();
  previous = performance.now();
  canvas.focus({ preventScroll: true });
  updateUI();
}

function selectWeapon(weapon: WeaponId): void {
  if (simulation.state.phase !== 'playing') return;
  clearInput();
  simulation.selectWeapon(weapon);
  canvas.focus({ preventScroll: true });
  updateUI();
}

function reload(): void {
  if (simulation.state.phase !== 'playing') return;
  audio.unlock();
  const events = simulation.reload();
  world.handleEvents(events);
  audio.play(events);
  canvas.focus({ preventScroll: true });
  updateUI();
}

function pause(): void {
  clearInput();
  if (simulation.state.phase !== 'playing') return;
  simulation.pause();
  updateUI();
  $('resume').focus({ preventScroll: true });
}

function resume(): void {
  clearInput();
  audio.unlock();
  simulation.resume();
  previous = performance.now();
  canvas.focus({ preventScroll: true });
  updateUI();
}

function aimAt(clientX: number, clientY: number): void {
  const point = world.screenToGround(clientX, clientY);
  if (!point) return;
  input.aim = { x: point.x, z: Math.min(point.z, RULES.playerZ - 0.8) };
  const bounds = canvas.getBoundingClientRect();
  const projected = world.project(input.aim);
  const reticle = $('reticle');
  reticle.style.left = `${projected.x - bounds.left}px`;
  reticle.style.top = `${projected.y - bounds.top}px`;
  reticle.hidden = simulation.state.phase !== 'playing';
}

canvas.addEventListener('pointermove', (event) => {
  pointer = { x: event.clientX, y: event.clientY };
  if (simulation.state.phase === 'playing') aimAt(event.clientX, event.clientY);
});
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary || simulation.state.phase !== 'playing') return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  pointer = { x: event.clientX, y: event.clientY };
  aimAt(event.clientX, event.clientY);
  input.firing = true;
  audio.unlock();
});
window.addEventListener('pointerup', clearInput);
canvas.addEventListener('pointercancel', clearInput);
canvas.addEventListener('lostpointercapture', clearInput);
canvas.addEventListener('pointerleave', () => {
  if (!input.firing) $('reticle').hidden = true;
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Escape' || event.code === 'KeyP') {
    if (simulation.state.phase === 'playing') pause();
    else if (simulation.state.phase === 'paused') resume();
  }
  if (event.code === 'KeyR') {
    if (simulation.state.phase === 'over') begin('retry');
    else reload();
  }
  const weaponIndex = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
  if (weaponIndex >= 0) selectWeapon(WEAPON_IDS[weaponIndex]);
});

$('start').addEventListener('click', () => begin());
$('restart').addEventListener('click', () => begin('retry'));
$('pause-restart').addEventListener('click', () => begin('retry'));
$('next-level').addEventListener('click', () => begin('nextLevel'));
$('campaign-restart').addEventListener('click', () => begin());
$('reload').addEventListener('click', reload);
for (const weapon of WEAPON_IDS) {
  $(`weapon-${weapon}`).addEventListener('click', () => selectWeapon(weapon));
}
$('resume').addEventListener('click', resume);
$('pause').addEventListener('click', () => {
  if (simulation.state.phase === 'paused') resume();
  else pause();
});
$('sound').addEventListener('click', () => {
  audio.muted = !audio.muted;
  $('sound').setAttribute('aria-pressed', String(audio.muted));
  $('sound').setAttribute('aria-label', audio.muted ? '开启声音' : '关闭声音');
  $('sound').classList.toggle('muted', audio.muted);
  if (!audio.muted) audio.unlock();
});

const formatTime = (value: number) =>
  `${Math.floor(value / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(value % 60)
    .toString()
    .padStart(2, '0')}`;

function updateUI(): void {
  const state = simulation.state;
  const phase = state.phase;
  const level = LEVELS[state.level - 1];
  const total = levelTotal(level);
  const weapon = WEAPONS[state.weapon];
  const cleared = phase === 'cleared' || phase === 'victory';
  document.body.dataset.phase = phase;
  $('intro').hidden = phase !== 'ready';
  $('hud').hidden = phase === 'ready';
  $('threat').hidden = phase === 'ready';
  $('pause-panel').hidden = phase !== 'paused';
  $('over-panel').hidden = phase !== 'over';
  $('clear-panel').hidden = !cleared;
  $('level-progress').hidden = phase === 'ready';
  $<HTMLButtonElement>('pause').disabled = phase !== 'playing' && phase !== 'paused';
  $('pause').setAttribute('aria-label', phase === 'paused' ? '继续游戏' : '暂停游戏');
  $('status').textContent = {
    ready: '等待部署',
    playing: '行动进行中',
    paused: '行动已暂停',
    over: '信号中断',
    cleared: '区域已肃清',
    victory: '行动成功',
  }[phase];
  $('level-label').textContent = `${String(state.level).padStart(2, '0')} / 05 · ${level.name}`;
  $('level-hint').textContent = level.subtitle;
  $('remaining').textContent = `剩余 ${total - state.kills} / ${total}`;
  $('level-fill').style.width = `${(state.kills / total) * 100}%`;
  $('wave-status').textContent =
    state.spawned >= total
      ? cleared
        ? '本关敌人已全部清除'
        : '所有敌人已到达 · 清除剩余目标'
      : `来袭 ${state.spawned} / ${total} · 后续来敌约 ${Math.max(0, Math.ceil(level.duration - state.elapsed))} 秒`;
  $('enemy-intel').textContent = [
    '游荡者 · 普通目标',
    '疾行者 · 血少速度快',
    '重装者 · 厚血行动慢',
    '潜行者 · 身小难瞄准',
    '混合来袭 · 切枪应对',
  ][state.level - 1];
  for (const id of WEAPON_IDS) {
    $<HTMLButtonElement>(`weapon-${id}`).disabled = phase !== 'playing';
    $(`weapon-${id}`).setAttribute('aria-pressed', String(state.weapon === id));
    $(`mag-${id}`).textContent = `${state.ammo[id]} / ${WEAPONS[id].magazine}`;
  }
  $('ammo-count').textContent = String(state.ammo[state.weapon]);
  $('ammo-count').classList.toggle('empty', state.ammo[state.weapon] === 0);
  $('ammo-capacity').textContent = String(weapon.magazine);
  $('reload-label').textContent =
    state.reloadRemaining > 0 ? `装填 ${state.reloadRemaining.toFixed(1)}s` : '装填';
  $<HTMLButtonElement>('reload').disabled =
    phase !== 'playing' ||
    state.reloadRemaining > 0 ||
    state.ammo[state.weapon] === weapon.magazine;
  const reloadProgress =
    state.reloadRemaining > 0 ? (1 - state.reloadRemaining / weapon.reloadTime) * 100 : 0;
  $('reload-fill').style.width = `${reloadProgress}%`;
  document
    .querySelector('[aria-label="装填进度"]')!
    .setAttribute('aria-valuenow', String(Math.round(reloadProgress)));
  $('hp').textContent = String(state.hp);
  $('health-fill').style.width = `${state.hp}%`;
  $('health-fill').classList.toggle('critical', state.hp <= 30);
  document.querySelector('[role="progressbar"]')!.setAttribute('aria-valuenow', String(state.hp));
  $('kills').textContent = state.kills.toString().padStart(2, '0');
  $('time').textContent = formatTime(state.elapsed);
  $('enemies').textContent = String(state.zombies.filter((zombie) => zombie.hp > 0).length);
  if (phase === 'over') {
    $('failure-copy').textContent =
      `第 ${state.level} 关 · ${level.name}。调整武器，再守住这道防线。`;
    $('result-kills').textContent = String(state.kills);
    $('result-time').textContent = formatTime(state.elapsed);
    $('result-accuracy').textContent =
      `${state.shots ? Math.round((state.hits / state.shots) * 100) : 0}%`;
    if (lastPhase !== 'over') {
      clearInput();
      $('restart').focus({ preventScroll: true });
    }
  }
  if (cleared) {
    $('clear-title').textContent = phase === 'victory' ? '全部通关' : '关卡完成';
    $('clear-summary').textContent =
      phase === 'victory'
        ? '五道防线全部守住。隔离区暂时安全了。'
        : `第 ${state.level} 关 · ${level.name}，已肃清全部 ${total} 个目标。`;
    $('clear-kills').textContent = String(state.kills);
    $('clear-time').textContent = formatTime(state.elapsed);
    $('clear-accuracy').textContent =
      `${state.shots ? Math.round((state.hits / state.shots) * 100) : 0}%`;
    $('next-hint').textContent =
      phase === 'victory'
        ? '试试不同武器组合，重新挑战五关战役。'
        : `接下来：${LEVELS[state.level].name} · ${LEVELS[state.level].subtitle}`;
    $('next-level').hidden = phase === 'victory';
    $('campaign-restart').hidden = phase !== 'victory';
    $('supply-note').hidden = phase === 'victory';
    if (lastPhase !== phase) {
      clearInput();
      $(phase === 'victory' ? 'campaign-restart' : 'next-level').focus({ preventScroll: true });
    }
  }
  lastPhase = phase;
}

const resizeObserver = new ResizeObserver(() => {
  world.resize();
  if (pointer && simulation.state.phase === 'playing') aimAt(pointer.x, pointer.y);
});
resizeObserver.observe($('arena'));

function frame(now: number): void {
  const wallDt = Math.max(0, (now - previous) / 1000);
  // Simulation substeps preserve the pace at low FPS; cap long stalls to avoid a catch-up burst.
  const dt = Math.min(wallDt, 0.25);
  previous = now;
  const phase = simulation.state.phase;
  const events = simulation.step(dt, input);
  world.handleEvents(events);
  audio.play(events);
  if (events.some((event) => event.type === 'hurt')) damageTime = 0.35;
  damageTime = Math.max(0, damageTime - dt);
  $('damage').style.opacity = String(damageTime / 0.35);
  // Keep newly emitted flashes visible for at least one rendered frame.
  world.render(simulation.state, input.aim, phase === 'paused' ? 0 : Math.min(dt, 0.05));
  uiAccumulator += dt;
  if (uiAccumulator >= 0.1 || phase !== simulation.state.phase) {
    updateUI();
    uiAccumulator = 0;
  }
  frames++;
  frameTime += wallDt;
  if (frameTime >= 1) {
    fps = Math.round(frames / frameTime);
    frames = 0;
    frameTime = 0;
  }
  requestAnimationFrame(frame);
}
updateUI();
requestAnimationFrame(frame);

// Read-only inspection exists only on the development server, explicitly opted in.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('inspect')) {
  Object.assign(window, {
    __game: {
      snapshot: () =>
        structuredClone({ ...simulation.state, fps, render: world.info, firing: input.firing }),
      project: (point: { x: number; z: number }) => world.project(point),
    },
  });
}
