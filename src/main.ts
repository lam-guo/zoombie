import './style.css';
import { GameAudio } from './game/audio';
import { Simulation } from './game/simulation';
import { World } from './game/world';
import {
  createProgress,
  getPrice,
  getReloadMultiplier,
  loadProgress,
  saveProgress,
  type ShopItemId,
} from './game/economy';
import {
  LEVELS,
  BOSSES,
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
      <span class="wallet" aria-label="金币余额">◈ <strong id="coins">0</strong></span>
      <button class="shop-button" id="open-shop">补给站</button>
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
        <div class="hud-label">${icon('shield')} 生命值 <strong><span id="hp">100</span><span class="dim"> / <span id="max-hp">100</span></span></strong></div>
        <div class="health-track" role="progressbar" aria-label="生命值" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i id="health-fill"></i></div>
        <div class="armor-line"><span>护甲 <b id="armor">0</b></span><span id="revive-status">无复活储备</span></div>
      </div>
      <div class="hud-metrics"><div><span>本关击杀</span><strong id="kills">00</strong></div><div><span>本关用时</span><strong id="time">00:00</strong></div></div>
    </div>
    <div class="boss-hud" id="boss-hud" hidden>
      <div><span id="boss-name"></span><strong id="boss-hp"></strong></div>
      <div class="boss-track"><i id="boss-fill"></i></div>
      <p id="boss-tip"></p><div id="boss-parts" class="boss-parts"></div>
      <small id="boss-warning"></small>
    </div>
    <div class="battle-supplies" id="battle-supplies" hidden>
      <span id="earned-coins">本关 +0 金币</span>
      <button id="auto-fire" class="supply-button auto-button" aria-label="自动射击" aria-pressed="false" title="自动瞄准与射击 · F">自动射击 <b id="auto-status">关</b><kbd>F</kbd></button>
      <button id="use-grenade" class="supply-button" title="向瞄准位置投掷手雷 · G">手雷 <b id="grenade-count">0</b><kbd>G</kbd></button>
      <button id="use-medkit" class="supply-button">血包 <b id="medkit-count">0</b><kbd>H</kbd></button>
    </div>
    <div class="reward-toast" id="reward-toast" role="status" aria-live="polite" hidden></div>
    <div class="level-progress" id="level-progress" hidden>
      <div><span id="level-hint"></span><strong id="remaining"></strong></div>
      <div class="level-track"><i id="level-fill"></i></div>
      <small id="wave-status"></small>
    </div>

    <section class="intro" id="intro" aria-labelledby="intro-title">
      <div class="eyebrow"><span></span> HOLD YOUR GROUND</div>
      <h1 id="intro-title">最后<span>防线。</span></h1>
      <p class="intro-copy">五道防线，两位异变首领。<br>轮换有限弹药，抵挡尸潮，升级你的火力。</p>
      <div class="intro-rule"></div>
      <div class="control-row"><span class="mouse-icon"></span><span>移动鼠标<span class="control-note">瞄准目标</span></span></div>
      <div class="control-row"><span class="mouse-icon pressed"></span><span>按住左键<span class="control-note">持续开火</span></span></div>
      <div class="control-row keyboard-row"><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 切枪</span><span><kbd>R</kbd> 装填</span></div>
      <button class="primary-button" id="start">进入战斗 ${icon('arrow')}</button>
      <div class="intro-meta"><span>F 自动射击</span><i></i><span>G 手雷</span><i></i><span>本机保存</span></div>
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
        <button class="text-button" data-open-shop>前往补给站 · 调整装备</button>
        <div class="keyboard-hint">或按 <kbd>R</kbd> 重试 · 生命与本关弹药补满</div>
      </section>
    </div>
    <div class="modal-wrap" id="clear-panel" hidden>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="clear-title">
        <div class="eyebrow">PERIMETER SECURED</div><h2 id="clear-title">关卡完成</h2>
        <p id="clear-summary"></p>
        <div class="result-grid"><div><span>本关击杀</span><strong id="clear-kills">0</strong></div><div><span>本关用时</span><strong id="clear-time">00:00</strong></div><div><span>命中率</span><strong id="clear-accuracy">0%</strong></div></div>
        <p id="next-hint"></p>
        <p class="settlement-reward" id="clear-reward"></p>
        <button class="text-button" data-open-shop>前往补给站 · 升级与补给</button>
        <button class="primary-button" id="next-level">下一关 ${icon('arrow')}</button>
        <button class="primary-button" id="campaign-restart" hidden>重新出击 ${icon('arrow')}</button>
        <div class="keyboard-hint" id="supply-note">下一关补满生命、弹匣与备弹 · 道具不返还</div>
      </section>
    </div>
    <div class="modal-wrap shop-wrap" id="shop-panel" hidden>
      <section class="shop-modal" role="dialog" aria-modal="true" aria-labelledby="shop-title">
        <div class="shop-heading"><div><div class="eyebrow">FIELD SUPPLY / 07</div><h2 id="shop-title">前线补给站</h2></div><button id="close-shop" class="shop-close" aria-label="关闭补给站">✕</button></div>
        <div class="shop-balance"><span>可用金币 <strong id="shop-coins">0</strong></span><small id="save-status">资产自动保存在此浏览器 · 刷新后从第一关出击</small></div>
        <div class="shop-grid" id="shop-grid"></div>
        <p class="shop-message" id="shop-message" role="status">升级永久保留；道具使用后需要重新购买。</p>
        <div class="shop-footer"><span>普通击杀 4–10 ◈ · 首领奖励 150 / 250 ◈<br>每关另有通关奖励，失败仍保留已获金币。</span><button class="shop-button" id="leave-shop">返回部署</button></div>
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
      <div class="ammo"><strong id="ammo-count">30</strong><span>/ <b id="ammo-capacity">30</b><small>备弹 <b id="ammo-reserve">60</b></small></span></div>
      <button id="reload" class="reload-button" aria-label="装填弹匣" disabled><span id="reload-label">装填</span><kbd>R</kbd></button>
      <div class="reload-track" role="progressbar" aria-label="装填进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="reload-fill"></i></div>
    </div>
  </footer>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
let storage: Storage | null = null;
let loaded = { progress: createProgress(), available: false };
try {
  storage = window.localStorage;
  loaded = loadProgress(storage);
} catch {
  // Storage can be disabled by browser privacy settings; the session remains playable.
}
const simulation = new Simulation(Math.random, loaded.progress);
let storageAvailable = loaded.available;
let lastSaved = JSON.stringify(loaded.progress);
let shopOpen = false;
let shopReturnFocus: HTMLElement | null = null;
let rewardTime = 0;
const shopItems: { id: ShopItemId; name: string; category: string; description: string }[] = [
  {
    id: 'rifle',
    name: '突击步枪强化',
    category: '01 / WEAPON',
    description: '每级伤害 +20% · 30 发持续压制',
  },
  {
    id: 'sniper',
    name: '狙击步枪强化',
    category: '02 / WEAPON',
    description: '每级伤害 +20% · 克制重甲首领',
  },
  {
    id: 'shotgun',
    name: '霰弹枪强化',
    category: '03 / WEAPON',
    description: '每级伤害 +20% · 近距扇面群伤',
  },
  {
    id: 'health',
    name: '体能训练',
    category: '04 / DEFENDER',
    description: '每级生命上限 +25 · 出击时补满',
  },
  {
    id: 'reload',
    name: '装填训练',
    category: '05 / DEFENDER',
    description: '每级装填时间 −10% · 三把枪生效',
  },
  {
    id: 'medkit',
    name: '急救血包',
    category: '06 / SUPPLY',
    description: '回复 50 生命 · 按 H 使用 · 最多 3 个',
  },
  {
    id: 'revive',
    name: '复活甲',
    category: '07 / SUPPLY',
    description: '致命伤自动复活一次 · 满血并无敌 3 秒',
  },
  {
    id: 'armor',
    name: '防弹衣',
    category: '08 / SUPPLY',
    description: '护甲补至 60 · 受伤先消耗护甲',
  },
  {
    id: 'grenade',
    name: '破片手榴弹',
    category: '09 / SUPPLY',
    description: 'G 投向准星 · 范围清敌，首领减伤 · 最多 3 枚',
  },
];
$('shop-grid').innerHTML = shopItems
  .map(
    (item) =>
      `<article class="shop-card"><small>${item.category}</small><div><h3>${item.name}</h3><span id="shop-level-${item.id}"></span></div><p>${item.description}</p><button id="buy-${item.id}" aria-label="购买${item.name}"><span id="shop-action-${item.id}">购买</span><strong id="shop-price-${item.id}"></strong></button></article>`,
  )
  .join('');
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

function persist(): void {
  const serialized = JSON.stringify(simulation.state.progress);
  if (serialized === lastSaved) return;
  storageAvailable = storage !== null && saveProgress(storage, simulation.state.progress);
  if (storageAvailable) lastSaved = serialized;
}

function updateShop(): void {
  const progress = simulation.state.progress;
  $('shop-coins').textContent = String(progress.coins);
  $('save-status').textContent = storageAvailable
    ? '资产自动保存在此浏览器 · 刷新后从第一关出击'
    : '浏览器存储不可用 · 本次仍可游玩，刷新将丢失资产';
  for (const item of shopItems) {
    const id = item.id;
    const level =
      id === 'health'
        ? progress.healthLevel
        : id === 'reload'
          ? progress.reloadLevel
          : WEAPON_IDS.includes(id as WeaponId)
            ? progress.weapons[id as WeaponId]
            : null;
    const price = getPrice(progress, id);
    $(`shop-level-${id}`).textContent =
      level !== null
        ? `Lv.${level} / 3`
        : id === 'medkit'
          ? `${progress.medkits} / 3`
          : id === 'grenade'
            ? `${progress.grenades} / 3`
            : id === 'revive'
              ? progress.revive
                ? '已装备'
                : '未装备'
              : `${progress.armor} / 60`;
    $(`shop-price-${id}`).textContent = price === null ? '—' : `${price} ◈`;
    $(`shop-action-${id}`).textContent =
      price === null
        ? level !== null
          ? '已满级'
          : '已备齐'
        : progress.coins < price
          ? '金币不足'
          : level !== null
            ? '升级'
            : '购买';
    $<HTMLButtonElement>(`buy-${id}`).disabled = price === null || progress.coins < price;
  }
}

function openShop(): void {
  if (!['ready', 'over', 'cleared', 'victory'].includes(simulation.state.phase)) return;
  clearInput();
  shopReturnFocus = document.activeElement as HTMLElement;
  shopOpen = true;
  $('shop-panel').hidden = false;
  for (const element of [
    ...$('arena').children,
    document.querySelector('.topbar')!,
    document.querySelector('.bottom-bar')!,
  ]) {
    if (element.id !== 'shop-panel') (element as HTMLElement).inert = true;
  }
  updateShop();
  $('close-shop').focus({ preventScroll: true });
}

function closeShop(): void {
  shopOpen = false;
  $('shop-panel').hidden = true;
  for (const element of [
    ...$('arena').children,
    document.querySelector('.topbar')!,
    document.querySelector('.bottom-bar')!,
  ])
    (element as HTMLElement).inert = false;
  shopReturnFocus?.focus({ preventScroll: true });
}

function useMedkit(): void {
  const events = simulation.useMedkit();
  if (events.length === 0) return;
  audio.unlock();
  world.handleEvents(events);
  audio.play(events);
  persist();
  updateUI();
}

function useGrenade(): void {
  const aim = simulation.state.autoAim ?? input.aim;
  const events = simulation.throwGrenade(aim);
  if (events.length === 0) return;
  audio.unlock();
  world.handleEvents(events);
  audio.play(events);
  persist();
  canvas.focus({ preventScroll: true });
  updateUI();
}

function toggleAutoFire(): void {
  clearInput();
  simulation.setAutoFire(!simulation.state.autoFire);
  audio.unlock();
  updateUI();
}

function clearInput(): void {
  input.firing = false;
  $('reticle').hidden = true;
}

function begin(action: 'start' | 'retry' | 'nextLevel' = 'start'): void {
  if (shopOpen) return;
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
  input.aim = { ...point, z: Math.min(point.z, RULES.playerZ - 0.8) };
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
  if (shopOpen) {
    if (event.code === 'Escape') closeShop();
    if (event.code === 'Tab') {
      const buttons = [
        ...$('shop-panel').querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      ];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (event.code === 'KeyH') useMedkit();
  if (event.code === 'KeyG') useGrenade();
  if (event.code === 'KeyF') toggleAutoFire();
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
$('use-medkit').addEventListener('click', useMedkit);
$('use-grenade').addEventListener('click', useGrenade);
$('auto-fire').addEventListener('click', toggleAutoFire);
$('open-shop').addEventListener('click', openShop);
document
  .querySelectorAll('[data-open-shop]')
  .forEach((button) => button.addEventListener('click', openShop));
$('close-shop').addEventListener('click', closeShop);
$('leave-shop').addEventListener('click', closeShop);
for (const item of shopItems) {
  $(`buy-${item.id}`).addEventListener('click', () => {
    if (!shopOpen || !simulation.purchase(item.id)) return;
    $('shop-message').textContent = `${item.name}已购入。升级与装备将在出击时生效。`;
    persist();
    updateShop();
    updateUI();
  });
}
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
  $('coins').textContent = String(state.progress.coins);
  $('earned-coins').textContent = `本关 +${state.earnedCoins} 金币`;
  $<HTMLButtonElement>('open-shop').disabled = !['ready', 'over', 'cleared', 'victory'].includes(
    phase,
  );
  $('battle-supplies').hidden = cleared || phase === 'over';
  $('earned-coins').hidden = phase === 'ready';
  $('use-medkit').hidden = phase === 'ready';
  $('use-grenade').hidden = phase === 'ready';
  $('auto-fire').setAttribute('aria-pressed', String(state.autoFire));
  $('auto-status').textContent = state.autoFire ? '开' : '关';
  $('grenade-count').textContent = String(state.progress.grenades);
  $<HTMLButtonElement>('use-grenade').disabled =
    phase !== 'playing' || state.progress.grenades === 0 || state.grenades.length > 0;
  $('medkit-count').textContent = String(state.progress.medkits);
  $<HTMLButtonElement>('use-medkit').disabled =
    phase !== 'playing' || state.hp >= state.maxHp || state.progress.medkits === 0;
  $('armor').textContent = String(state.progress.armor);
  $('revive-status').textContent =
    state.invulnerable > 0
      ? `无敌 ${state.invulnerable.toFixed(1)}s`
      : state.progress.revive
        ? '复活甲 ×1'
        : '无复活储备';
  const boss = state.boss;
  document.body.dataset.boss = boss && boss.hp > 0 ? 'active' : 'none';
  $('boss-hud').hidden = !boss || boss.hp <= 0 || phase === 'over' || cleared;
  if (boss && boss.hp > 0) {
    const aliveParts = boss.parts.filter((part) => part.hp > 0);
    $('boss-name').textContent = `BOSS / ${BOSSES[boss.kind].name}`;
    $('boss-hp').textContent = `${Math.ceil(boss.hp)} / ${boss.maxHp}`;
    $('boss-fill').style.width = `${(boss.hp / boss.maxHp) * 100}%`;
    $('boss-tip').textContent =
      boss.kind === 'bulwark'
        ? '装甲抵抗常规伤害 · 狙击伤害 ×1.5'
        : aliveParts.length > 0
          ? '核心受保护 · 瞄准发光瘤，逐个击破'
          : '核心已暴露 · 集中火力！';
    $('boss-parts').innerHTML = boss.parts
      .map(
        (part) =>
          `<span class="${part.hp <= 0 ? 'broken' : ''}">弱点 ${part.id + 1} · ${part.hp <= 0 ? '已破坏' : Math.ceil(part.hp)}<i style="width:${(part.hp / part.maxHp) * 100}%"></i></span>`,
      )
      .join('');
    $('boss-warning').textContent =
      boss.attackRemaining <= 2
        ? `⚠ 首领攻击预警 · ${Math.max(0, boss.attackRemaining).toFixed(1)}s`
        : '备好血包与护甲，应对首领攻击';
    $('boss-hud').classList.toggle('warning', boss.attackRemaining <= 2);
  }
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
    state.hordeRemaining > 0
      ? '⚠ 尸潮来袭 · 用霰弹、穿透与手雷压制密集目标'
      : state.spawned >= total
        ? cleared
          ? '本关敌人已全部清除'
          : '所有敌人已到达 · 清除剩余目标'
        : `来袭 ${state.spawned} / ${total} · 后续来敌约 ${Math.max(0, Math.ceil(level.duration - state.elapsed))} 秒`;
  $('wave-status').classList.toggle('horde-warning', state.hordeRemaining > 0);
  $('enemy-intel').textContent = [
    '游荡者 · 普通目标',
    '疾行者 · 快速接近，受击易僵直',
    '重甲巨兽 · 狙击克制',
    '潜行者 · 可能闪避，范围火力压制',
    '孵化主宰 · 逐个击破弱点',
  ][state.level - 1];
  for (const id of WEAPON_IDS) {
    $<HTMLButtonElement>(`weapon-${id}`).disabled = phase !== 'playing';
    $(`weapon-${id}`).setAttribute('aria-pressed', String(state.weapon === id));
    $(`mag-${id}`).textContent =
      `${state.ammo[id]} + ${state.reserve[id]} · Lv.${state.progress.weapons[id]}`;
    $(`weapon-${id}`).classList.toggle('depleted', state.ammo[id] + state.reserve[id] === 0);
  }
  $('ammo-count').textContent = String(state.ammo[state.weapon]);
  $('ammo-count').classList.toggle('empty', state.ammo[state.weapon] === 0);
  $('ammo-capacity').textContent = String(weapon.magazine);
  $('ammo-reserve').textContent = String(state.reserve[state.weapon]);
  const exhausted = WEAPON_IDS.every((id) => state.ammo[id] + state.reserve[id] === 0);
  if (exhausted && phase === 'playing') {
    $('status').textContent = '弹药耗尽';
    $('wave-status').textContent = '三枪弹药耗尽 · 使用手雷或暂停重试本关';
  }
  $('reload-label').textContent =
    state.reloadRemaining > 0
      ? `${weapon.reloadType === 'round' ? '装入一发' : '装填'} ${state.reloadRemaining.toFixed(1)}s`
      : state.reserve[state.weapon] === 0
        ? '无备弹'
        : weapon.reloadType === 'round'
          ? '逐发装填'
          : '装填';
  $<HTMLButtonElement>('reload').disabled =
    phase !== 'playing' ||
    state.reserve[state.weapon] === 0 ||
    state.reloadRemaining > 0 ||
    state.ammo[state.weapon] === weapon.magazine;
  const reloadProgress =
    state.reloadRemaining > 0
      ? (1 - state.reloadRemaining / (weapon.reloadTime * getReloadMultiplier(state.progress))) *
        100
      : 0;
  $('reload-fill').style.width = `${reloadProgress}%`;
  document
    .querySelector('[aria-label="装填进度"]')!
    .setAttribute('aria-valuenow', String(Math.round(reloadProgress)));
  $('hp').textContent = String(state.hp);
  $('max-hp').textContent = String(state.maxHp);
  $('health-fill').style.width = `${(state.hp / state.maxHp) * 100}%`;
  $('health-fill').classList.toggle('critical', state.hp <= 30);
  document.querySelector('[role="progressbar"]')!.setAttribute('aria-valuenow', String(state.hp));
  document
    .querySelector('[aria-label="生命值"]')!
    .setAttribute('aria-valuemax', String(state.maxHp));
  $('kills').textContent = state.kills.toString().padStart(2, '0');
  $('time').textContent = formatTime(state.elapsed);
  $('enemies').textContent = String(state.zombies.filter((zombie) => zombie.hp > 0).length);
  if (phase === 'over') {
    $('failure-copy').textContent =
      `第 ${state.level} 关 · ${level.name}。已保留本关获得的 ${state.earnedCoins} 金币，可以先补给再挑战。`;
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
    $('clear-reward').textContent =
      `本关共获得 ${state.earnedCoins} ◈${boss?.hp === 0 ? ' · 首领奖励已入账' : ''}`;
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
  if (events.length > 0) persist();
  const reward = events.reduce(
    (sum, event) => sum + (event.type === 'coins' ? event.amount : 0),
    0,
  );
  if (reward > 0) {
    $('reward-toast').textContent = `+${reward} ◈ 金币已拾取`;
    rewardTime = 1.5;
  }
  if (events.some((event) => event.type === 'revive')) {
    $('reward-toast').textContent = '复活甲已消耗 · 满血复活 · 无敌 3 秒';
    rewardTime = 3;
  }
  rewardTime = Math.max(0, rewardTime - dt);
  $('reward-toast').hidden = rewardTime === 0;
  if (events.some((event) => event.type === 'hurt')) damageTime = 0.35;
  damageTime = Math.max(0, damageTime - dt);
  $('damage').style.opacity = String(damageTime / 0.35);
  // Keep newly emitted flashes visible for at least one rendered frame.
  const renderAim = simulation.state.autoFire ? (simulation.state.autoAim ?? input.aim) : input.aim;
  if (simulation.state.autoFire) {
    const reticle = $('reticle');
    reticle.hidden = simulation.state.phase !== 'playing' || simulation.state.autoAim === null;
    if (!reticle.hidden) {
      const bounds = canvas.getBoundingClientRect();
      const projected = world.project(renderAim);
      reticle.style.left = `${projected.x - bounds.left}px`;
      reticle.style.top = `${projected.y - bounds.top}px`;
    }
  }
  world.render(simulation.state, renderAim, phase === 'paused' ? 0 : Math.min(dt, 0.05));
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
      project: (point: { x: number; z: number; y?: number }) => world.project(point),
      bossPartPositions: () => world.bossPartPositions(),
    },
  });
}
