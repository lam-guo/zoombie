import './style.css';
import { GameAudio } from './game/audio';
import { Simulation } from './game/simulation';
import { World } from './game/world';
import { RULES, type GameInput } from './game/types';

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
    <div class="mission-tag"><span class="live-dot"></span> 隔离区防卫行动 <span class="slash">/</span> 无尽生存</div>
    <div class="toolbar">
      <button class="icon-button" id="sound" aria-label="关闭声音" aria-pressed="false" title="声音">${icon('sound')}</button>
      <button class="icon-button" id="pause" aria-label="暂停游戏" title="暂停 · Esc" disabled>${icon('pause')}</button>
    </div>
  </header>

  <main class="arena" id="arena" aria-label="3D 战斗场地">
    <canvas id="game" aria-label="鼠标移动瞄准，按住左键开火" tabindex="0"></canvas>
    <div class="scene-vignette"></div>
    <div class="arena-label"><span class="bracket">⌜</span><span>北侧检查站<small>NORTH CHECKPOINT · 07</small></span></div>
    <div class="area-status"><span class="live-dot"></span><span id="status">等待部署</span></div>

    <div class="hud" id="hud" hidden>
      <div class="health-block">
        <div class="hud-label">${icon('shield')} 生命值 <strong><span id="hp">100</span><span class="dim"> / 100</span></strong></div>
        <div class="health-track" role="progressbar" aria-label="生命值" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i id="health-fill"></i></div>
      </div>
      <div class="hud-metrics"><div><span>已击杀</span><strong id="kills">00</strong></div><div><span>生存时间</span><strong id="time">00:00</strong></div></div>
    </div>

    <section class="intro" id="intro" aria-labelledby="intro-title">
      <div class="eyebrow"><span></span> HOLD YOUR GROUND</div>
      <h1 id="intro-title">最后<span>防线。</span></h1>
      <p class="intro-copy">他们正在靠近。<br>守住阵地，让每一发子弹都有意义。</p>
      <div class="intro-rule"></div>
      <div class="control-row"><span class="mouse-icon"></span><span>移动鼠标<span class="control-note">瞄准目标</span></span></div>
      <div class="control-row"><span class="mouse-icon pressed"></span><span>按住左键<span class="control-note">持续开火</span></span></div>
      <button class="primary-button" id="start">进入战斗 ${icon('arrow')}</button>
      <div class="intro-meta"><span>单人行动</span><i></i><span>无限弹药</span><i></i><span>坚持到最后</span></div>
    </section>

    <div class="reticle" id="reticle" hidden><i></i><i></i><i></i><i></i><b></b></div>
    <div class="damage-vignette" id="damage"></div>

    <div class="modal-wrap" id="pause-panel" hidden>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <div class="eyebrow">TAKE A BREATH</div><h2 id="pause-title">行动暂停</h2>
        <p>阵地已冻结。准备好后，继续防守。</p>
        <button class="primary-button" id="resume">继续战斗 ${icon('arrow')}</button>
        <button class="text-button" id="pause-restart">重新开始</button>
      </section>
    </div>
    <div class="modal-wrap" id="over-panel" hidden>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="over-title">
        <div class="eyebrow">THE LINE HAS FALLEN</div><h2 id="over-title">防线失守</h2>
        <p>这一次，你坚持到了这里。</p>
        <div class="result-grid"><div><span>击杀僵尸</span><strong id="result-kills">0</strong></div><div><span>生存时间</span><strong id="result-time">00:00</strong></div><div><span>命中率</span><strong id="result-accuracy">0%</strong></div></div>
        <button class="primary-button" id="restart">再次出击 ${icon('arrow')}</button>
        <div class="keyboard-hint">或按 <kbd>R</kbd> 重新开始</div>
      </section>
    </div>
    <div class="modal-wrap" id="error-panel" hidden>
      <section class="modal" role="alert"><div class="eyebrow">RENDERER UNAVAILABLE</div><h2>无法启动 3D 场景</h2><p>请使用支持 WebGL 2 的浏览器，并开启硬件加速后刷新页面。</p></section>
    </div>

    <div class="scene-bottom"><span class="coordinates">ZONE 07 <i></i> PERIMETER DEFENSE</span><span id="threat" hidden>场上威胁 <b id="enemies">0</b></span></div>
  </main>

  <footer class="bottom-bar">
    <div class="weapon-icon"><svg viewBox="0 0 80 32" aria-hidden="true"><path d="M4 10h13l6 4h29v-3h10v4h14v4H50l-5 7h-7l3-7H25l-6 9h-7l5-12H4z" fill="currentColor"/><path d="M28 10h12v4H28z" fill="currentColor"/></svg></div>
    <div class="weapon-name">AR-01 <span>突击步枪</span><small>自动步枪 · 近距防卫</small></div>
    <div class="ammo"><strong>∞</strong><span>弹药充足</span></div>
    <div class="footer-divider"></div>
    <div class="footer-controls"><span>${icon('crosshair')} 移动瞄准</span><span><b class="tiny-dot"></b> 长按开火</span><span><kbd>ESC</kbd> 暂停</span></div>
    <div class="footer-note"><span class="live-dot"></span> 守住最后一道防线</div>
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

function start(): void {
  audio.unlock();
  clearInput();
  world.clearEffects();
  damageTime = 0;
  $('damage').style.opacity = '0';
  input.aim = { x: 0, z: -5 };
  simulation.start();
  previous = performance.now();
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
  if (event.repeat) return;
  if (event.code === 'Escape' || event.code === 'KeyP') {
    if (simulation.state.phase === 'playing') pause();
    else if (simulation.state.phase === 'paused') resume();
  }
  if (event.code === 'KeyR' && simulation.state.phase === 'over') start();
});

$('start').addEventListener('click', start);
$('restart').addEventListener('click', start);
$('pause-restart').addEventListener('click', start);
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
  document.body.dataset.phase = phase;
  $('intro').hidden = phase !== 'ready';
  $('hud').hidden = phase === 'ready';
  $('threat').hidden = phase === 'ready';
  $('pause-panel').hidden = phase !== 'paused';
  $('over-panel').hidden = phase !== 'over';
  $<HTMLButtonElement>('pause').disabled = phase === 'ready' || phase === 'over';
  $('pause').setAttribute('aria-label', phase === 'paused' ? '继续游戏' : '暂停游戏');
  $('status').textContent = {
    ready: '等待部署',
    playing: '行动进行中',
    paused: '行动已暂停',
    over: '信号中断',
  }[phase];
  $('hp').textContent = String(state.hp);
  $('health-fill').style.width = `${state.hp}%`;
  $('health-fill').classList.toggle('critical', state.hp <= 30);
  document.querySelector('[role="progressbar"]')!.setAttribute('aria-valuenow', String(state.hp));
  $('kills').textContent = state.kills.toString().padStart(2, '0');
  $('time').textContent = formatTime(state.elapsed);
  $('enemies').textContent = String(state.zombies.filter((zombie) => zombie.hp > 0).length);
  if (phase === 'over') {
    $('result-kills').textContent = String(state.kills);
    $('result-time').textContent = formatTime(state.elapsed);
    $('result-accuracy').textContent =
      `${state.shots ? Math.round((state.hits / state.shots) * 100) : 0}%`;
    if (lastPhase !== 'over') {
      clearInput();
      $('restart').focus({ preventScroll: true });
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
  const dt = Math.min(wallDt, 0.05);
  previous = now;
  const phase = simulation.state.phase;
  const events = simulation.step(dt, input);
  world.handleEvents(events);
  audio.play(events);
  if (events.some((event) => event.type === 'hurt')) damageTime = 0.35;
  damageTime = Math.max(0, damageTime - dt);
  $('damage').style.opacity = String(damageTime / 0.35);
  world.render(simulation.state, input.aim, phase === 'paused' ? 0 : dt);
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
