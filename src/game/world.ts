import * as THREE from 'three';
import { BOSSES, bossPartPosition, LEVELS, WEAPONS, WEAPON_IDS, ZOMBIES } from './types';
import type { Boss, BossKind, GameEvent, GameState, Point, WeaponId, Zombie } from './types';
import { getReloadMultiplier } from './economy';

type Actor = {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  arms: [THREE.Group, THREE.Group];
  legs: [THREE.Group, THREE.Group];
  skin: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  shadow: THREE.Mesh;
  armor: THREE.Group;
  health: THREE.Group;
  healthFill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
};

type Effect = {
  mesh: THREE.Mesh;
  life: number;
  duration: number;
  velocity: THREE.Vector3;
};

type BossModel = {
  root: THREE.Group;
  body: THREE.Group;
  limbs: THREE.Group[];
  armor: THREE.MeshStandardMaterial;
  core: THREE.Mesh;
  parts: Map<number, THREE.Group>;
};

const UP = new THREE.Vector3(0, 1, 0);
const PALETTE = {
  ground: '#35423f',
  dark: '#192927',
  steel: '#52655d',
  concrete: '#79877b',
  yellow: '#deb665',
};

/** A small, self-contained stage. All art is generated locally, without asset requests. */
export class World {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(43, 1, 0.1, 125);
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly pointer = new THREE.Vector2();
  private readonly intersection = new THREE.Vector3();
  private readonly vector = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly actors = new Map<number, Actor>();
  private readonly spareActors: Actor[] = [];
  private readonly tracers: Effect[] = [];
  private readonly sparks: Effect[] = [];
  private readonly coins: Effect[] = [];
  private readonly bosses = new Map<BossKind, BossModel>();
  private boss: Boss | null = null;
  private readonly bossWarning = new THREE.Group();
  private readonly recoveryRing = new THREE.Group();
  private recoveryTime = 0;
  private readonly aimOccluders: THREE.Object3D[] = [];
  private readonly player: Actor;
  private readonly weapons = new Map<WeaponId, THREE.Group>();
  private readonly gun = new THREE.Group();
  private readonly muzzle = new THREE.Group();
  private readonly reticle = new THREE.Group();
  private readonly spreadGuide = new THREE.Group();
  private readonly aimLine: THREE.Line;
  private readonly cube = this.geometry(new THREE.BoxGeometry(1, 1, 1));
  private readonly cylinder = this.geometry(new THREE.CylinderGeometry(1, 1, 1, 8));
  private readonly sphere = this.geometry(new THREE.IcosahedronGeometry(1, 0));
  private readonly plane = this.geometry(new THREE.PlaneGeometry(1, 1));
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly sky: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private zoneMaterial!: THREE.MeshStandardMaterial;
  private lampMaterial!: THREE.MeshBasicMaterial;
  private readonly levelLabels: THREE.CanvasTexture[] = [];
  private readonly cameraPosition = new THREE.Vector3(7.5, 25, 27);
  private readonly cameraTarget = new THREE.Vector3(0, 0, -4.5);
  private time = 0;
  private flashTime = 0;
  private recoil = 0;
  private trauma = 0;
  private width = 1;
  private height = 1;
  private currentLevel = 0;
  private currentWeapon: WeaponId = 'rifle';

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.scene.background = new THREE.Color('#263733');
    this.scene.fog = new THREE.FogExp2('#263733', 0.018);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraTarget);

    const sky = (this.sky = new THREE.HemisphereLight('#d4e3d0', '#29362e', 2.4));
    this.scene.add(sky);
    const sun = (this.sun = new THREE.DirectionalLight('#f5dfb5', 3.1));
    sun.position.set(-9, 23, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    sun.shadow.camera.left = -23;
    sun.shadow.camera.right = 23;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -24;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 75;
    sun.shadow.normalBias = 0.045;
    sun.shadow.bias = -0.0002;
    sun.target.position.set(0, 0, -5);
    this.scene.add(sun, sun.target);

    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 64;
    const shadowContext = shadowCanvas.getContext('2d')!;
    const gradient = shadowContext.createRadialGradient(32, 32, 2, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(0,0,0,0.42)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    shadowContext.fillStyle = gradient;
    shadowContext.fillRect(0, 0, 64, 64);
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    this.textures.add(shadowTexture);
    this.shadowMaterial = this.material(
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.buildStage();
    this.player = this.createActor(true, 0);
    this.player.root.position.set(0, 0, 7);
    this.scene.add(this.player.root);
    this.buildWeapons();
    this.buildReticle();

    const aimGeometry = this.geometry(new THREE.BufferGeometry());
    aimGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    aimGeometry.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(2), 1));
    this.aimLine = new THREE.Line(
      aimGeometry,
      this.material(
        new THREE.LineDashedMaterial({
          color: '#ebd89c',
          transparent: true,
          opacity: 0.3,
          dashSize: 0.22,
          gapSize: 0.22,
        }),
      ),
    );
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);
    this.buildEffects();
    this.buildBosses();
    this.resize();
  }

  get info(): { drawCalls: number; triangles: number; effects: number } {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      effects:
        this.tracers.filter((effect) => effect.life > 0).length +
        this.sparks.filter((effect) => effect.life > 0).length +
        this.coins.filter((effect) => effect.life > 0).length +
        Number(this.flashTime > 0),
    };
  }

  private geometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private material<T extends THREE.Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  private surface(color: string, roughness = 0.9, metalness = 0): THREE.MeshStandardMaterial {
    return this.material(
      new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true }),
    );
  }

  private box(
    parent: THREE.Object3D,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    shadow = true,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.cube, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, depth);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private pole(
    parent: THREE.Object3D,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.cylinder, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(radius, height, radius);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private groundMark(
    parent: THREE.Object3D,
    material: THREE.Material,
    x: number,
    z: number,
    width: number,
    depth: number,
    angle = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.plane, material);
    mesh.rotation.set(-Math.PI / 2, 0, angle);
    mesh.position.set(x, 0.025, z);
    mesh.scale.set(width, depth, 1);
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private textTexture(text: string, color: string, background?: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d')!;
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.font = 'bold 78px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = color;
    context.fillText(text, 256, 65);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(texture);
    return texture;
  }

  private buildStage(): void {
    const asphalt = this.surface(PALETTE.ground);
    const dark = this.surface(PALETTE.dark);
    const concrete = this.surface(PALETTE.concrete);
    const steel = this.surface(PALETTE.steel, 0.65, 0.3);
    const yellow = this.surface(PALETTE.yellow);
    const white = this.surface('#a0aca0');
    const black = this.surface('#28332d');
    const rust = this.surface('#7f5940');
    const warmGlow = (this.lampMaterial = this.material(
      new THREE.MeshBasicMaterial({ color: '#ffda85' }),
    ));
    const surface = new THREE.Mesh(this.geometry(new THREE.PlaneGeometry(100, 110)), asphalt);
    surface.rotation.x = -Math.PI / 2;
    surface.position.z = -15;
    surface.receiveShadow = true;
    this.scene.add(surface);

    // A deterministic scatter keeps the arena reproducible and leaves the central lane unobstructed.
    let seed = 90210;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const stains = this.material(
      new THREE.MeshBasicMaterial({
        color: '#172622',
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    for (let i = 0; i < 78; i++) {
      this.groundMark(
        this.scene,
        stains,
        (random() - 0.5) * 39,
        random() * 52 - 34,
        0.1 + random() * 2.7,
        0.07 + random() * 0.4,
        random() * Math.PI,
      );
    }
    for (const side of [-1, 1]) {
      this.groundMark(this.scene, yellow, side * 9.6, -6, 0.09, 37);
      this.box(this.scene, concrete, side * 11.1, 0.16, -6, 1.2, 0.32, 39);
      this.box(this.scene, dark, side * 11.1, 0.35, -6, 0.07, 0.12, 39);
      for (let z = -22; z < 10; z += 5.8) {
        this.groundMark(this.scene, white, side * 4.8, z, 0.13, 2.7);
      }
    }
    for (let x = -7; x <= 7; x += 0.9) {
      this.groundMark(this.scene, yellow, x, 10, 0.35, 1.3, -0.48);
      this.groundMark(this.scene, yellow, x, -24, 0.35, 1.3, -0.48);
    }
    this.groundMark(this.scene, white, 0, 5, 6.8, 0.12);
    this.groundMark(this.scene, white, 0, -15, 6.8, 0.12);
    LEVELS.forEach((_, index) =>
      this.levelLabels.push(this.textTexture(`STAGE 0${index + 1}`, '#a9b4a0')),
    );
    const zoneLabel = (this.zoneMaterial = this.material(
      new THREE.MeshStandardMaterial({
        map: this.levelLabels[0],
        transparent: true,
        roughness: 1,
        depthWrite: false,
        opacity: 0.36,
      }),
    ));
    this.groundMark(this.scene, zoneLabel, 0, -10, 6.2, 1.55);

    const containerColors = ['#416358', '#637264', '#465953', '#746544'];
    for (const [index, item] of [
      [-14, -17, 0.035],
      [14, -20, -0.035],
      [-15, -4, 0.01],
      [15, 1, -0.025],
      [-15, -29, 0],
      [14, -32, 0],
    ].entries()) {
      const [x, z, angle] = item;
      const container = new THREE.Group();
      container.position.set(x, 0, z);
      container.rotation.y = angle;
      this.scene.add(container);
      const paint = this.surface(containerColors[index % containerColors.length]);
      this.box(container, paint, 0, 1.6, 0, 4.3, 3.2, 8.7);
      this.box(container, steel, 0, 3.25, 0, 4.42, 0.12, 8.82);
      for (let rib = -3.9; rib <= 4; rib += 0.65) {
        this.box(container, paint, -2.18, 1.58, rib, 0.1, 2.9, 0.09, false);
        this.box(container, paint, 2.18, 1.58, rib, 0.1, 2.9, 0.09, false);
      }
      this.box(container, steel, 0, 1.62, 4.4, 0.08, 3, 0.04);
      this.box(container, steel, -1, 1.5, 4.42, 0.055, 2.55, 0.06);
      this.box(container, steel, 1, 1.5, 4.42, 0.055, 2.55, 0.06);
      this.box(container, yellow, -1.4, 2.5, 4.44, 0.44, 0.23, 0.03);
      if (index === 4) this.box(container, paint, 0.5, 4.7, 0.2, 4.3, 2.8, 8.7);
    }

    for (const side of [-1, 1]) {
      for (let z = -22; z < 14; z += 10.5) {
        const x = side * 10.7;
        this.box(this.scene, concrete, x, 0.18, z, 0.7, 0.36, 0.7);
        this.pole(this.scene, steel, x, 3.15, z, 0.08, 6);
        this.box(this.scene, steel, x - side * 0.6, 6.12, z, 1.35, 0.1, 0.12);
        this.box(this.scene, black, x - side * 1.12, 6.06, z, 0.55, 0.16, 0.36);
        this.box(this.scene, warmGlow, x - side * 1.12, 5.966, z, 0.42, 0.025, 0.26, false);
      }
      // Railings and alternating painted concrete barriers frame the playing space.
      for (let z = -18; z < 7; z += 8) {
        this.box(this.scene, steel, side * 11, 0.9, z, 0.15, 0.2, 4.3);
        this.box(this.scene, steel, side * 11, 0.56, z, 0.13, 0.14, 4.3);
        for (const offset of [-1.8, 1.8])
          this.box(this.scene, steel, side * 11, 0.55, z + offset, 0.13, 1.1, 0.13);
      }
      for (let i = 0; i < 2; i++) {
        const barrier = new THREE.Group();
        barrier.position.set(side * (8.2 + i * 3.2), 0, 12.4);
        barrier.rotation.y = side * 0.08;
        this.scene.add(barrier);
        this.box(barrier, concrete, 0, 0.38, 0, 2.6, 0.76, 0.65);
        this.box(barrier, yellow, 0, 0.78, 0, 2.6, 0.08, 0.6);
        for (let stripe = -0.9; stripe <= 0.9; stripe += 0.62) {
          const patch = this.box(barrier, black, stripe, 0.42, 0.334, 0.24, 0.55, 0.025, false);
          patch.rotation.z = -0.3;
        }
      }
      for (let i = 0; i < 7; i++) {
        const x = side * (12 + random() * 3);
        const z = -24 + random() * 33;
        if (i % 3 === 0) {
          this.pole(this.scene, rust, x, 0.55, z, 0.37, 1.1);
          this.pole(this.scene, steel, x, 0.19, z, 0.39, 0.06);
          this.pole(this.scene, steel, x, 0.87, z, 0.39, 0.06);
        } else {
          const crate = this.box(this.scene, i % 2 ? dark : concrete, x, 0.38, z, 0.8, 0.76, 0.85);
          crate.rotation.y = random();
        }
      }
    }

    // The distant gate provides a readable horizon through the haze.
    this.box(this.scene, dark, 0, 1.9, -32, 24, 3.8, 0.45);
    for (let x = -11; x <= 11; x += 2.2)
      this.box(this.scene, steel, x, 2.15, -31.7, 0.12, 4.3, 0.15);
    this.box(this.scene, steel, 0, 4.2, -31.7, 24, 0.15, 0.18);
    const gateLabel = this.material(
      new THREE.MeshBasicMaterial({
        map: this.textTexture('QUARANTINE', '#e5c686', '#2a3930'),
      }),
    );
    const sign = new THREE.Mesh(this.plane, gateLabel);
    sign.position.set(0, 3.5, -31.42);
    sign.scale.set(6.5, 1.6, 1);
    this.scene.add(sign);
    for (const x of [-9, 9]) this.box(this.scene, warmGlow, x, 4.5, -31.7, 0.18, 0.24, 0.18, false);
    this.batchScenery();
    this.scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh &&
        !Array.isArray(object.material) &&
        !object.material.transparent
      ) {
        this.aimOccluders.push(object);
      }
    });
  }

  private setLevel(level: number): void {
    const index = Math.max(0, Math.min(LEVELS.length - 1, level - 1));
    const accent = new THREE.Color(LEVELS[index].color);
    const background = (this.scene.background as THREE.Color).set('#263733').lerp(accent, 0.08);
    (this.scene.fog as THREE.FogExp2).color.copy(background);
    this.sky.color.set('#d4e3d0').lerp(accent, 0.24);
    this.sun.color.set('#f5dfb5').lerp(accent, 0.3);
    this.lampMaterial.color.set('#ffda85').lerp(accent, 0.55);
    this.zoneMaterial.map = this.levelLabels[index];
    this.currentLevel = level;
  }

  private batchScenery(): void {
    // Repeated scenery shares a handful of draw calls, including its shadow pass.
    const batches = new Map<string, THREE.Mesh[]>();
    this.scene.updateMatrixWorld(true);
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      const key = `${object.geometry.uuid}:${object.material.uuid}:${object.castShadow}`;
      const batch = batches.get(key) ?? [];
      batch.push(object);
      batches.set(key, batch);
    });
    for (const objects of batches.values()) {
      if (objects.length < 2) continue;
      const first = objects[0];
      const batch = new THREE.InstancedMesh(first.geometry, first.material, objects.length);
      batch.castShadow = first.castShadow;
      batch.receiveShadow = first.receiveShadow;
      objects.forEach((object, index) => {
        batch.setMatrixAt(index, object.matrixWorld);
        object.removeFromParent();
      });
      batch.computeBoundingSphere();
      this.scene.add(batch);
    }
  }

  private createActor(soldier: boolean, variant: number): Actor {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const skin = this.surface(soldier ? '#bb9f77' : ['#91a37b', '#839b85', '#a1a084'][variant % 3]);
    const cloth = this.surface(
      soldier ? '#d1cf9d' : ['#586e5e', '#78715b', '#566d70'][variant % 3],
    );
    const dark = this.surface(soldier ? '#283d36' : '#37433b');
    const vest = this.surface(soldier ? '#87976c' : '#586553');
    const boots = this.surface('#26372f');
    const head = new THREE.Group();
    head.position.set(0, 1.8, -0.015);
    body.add(head);
    this.box(head, skin, 0, 0, 0, 0.37, 0.42, 0.36);
    this.box(head, skin, 0, -0.15, -0.1, 0.29, 0.16, 0.3);
    const eyes = this.material(
      new THREE.MeshBasicMaterial({ color: soldier ? '#27352e' : '#dec477' }),
    );
    this.box(head, eyes, -0.09, 0.025, -0.191, 0.065, 0.045, 0.015, false);
    this.box(head, eyes, 0.09, 0.025, -0.191, 0.065, 0.045, 0.015, false);
    this.box(body, cloth, 0, 1.25, 0, 0.65, 0.76, 0.37);
    this.box(body, dark, 0, 0.8, 0, 0.56, 0.2, 0.32);
    if (soldier) {
      this.box(head, vest, 0, 0.15, 0.025, 0.47, 0.24, 0.44);
      this.box(head, vest, 0, 0.065, -0.22, 0.46, 0.055, 0.15);
      this.box(head, dark, 0, -0.16, -0.2, 0.3, 0.13, 0.035);
      this.box(body, vest, 0, 1.27, -0.23, 0.56, 0.59, 0.17);
      this.box(body, dark, 0, 1.24, 0.31, 0.5, 0.63, 0.27);
      this.box(body, vest, -0.16, 1.12, -0.35, 0.15, 0.19, 0.1);
      this.box(body, vest, 0.05, 1.12, -0.35, 0.15, 0.19, 0.1);
      this.box(body, this.surface('#e1b764'), 0.24, 1.48, -0.33, 0.1, 0.07, 0.04, false);
    } else {
      this.box(body, skin, -0.22, 1.13, -0.2, 0.16, 0.24, 0.03);
      this.box(body, dark, 0.14, 1.49, -0.2, 0.21, 0.04, 0.025);
      this.box(head, dark, 0.02, 0.2, 0.07, 0.36, 0.1, 0.3);
    }
    const armor = new THREE.Group();
    armor.visible = false;
    if (!soldier) {
      this.box(armor, dark, -0.39, 1.55, 0, 0.31, 0.25, 0.47);
      this.box(armor, dark, 0.39, 1.55, 0, 0.31, 0.25, 0.47);
      this.box(armor, dark, 0, 1.27, -0.23, 0.56, 0.52, 0.12);
    }
    body.add(armor);
    const arms: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
    const legs: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
    for (const [i, side] of [-1, 1].entries()) {
      const arm = arms[i];
      arm.position.set(side * 0.43, 1.51, 0);
      arm.rotation.z = -side * 0.1;
      this.box(arm, cloth, 0, -0.2, 0, 0.24, 0.43, 0.25);
      this.box(arm, skin, 0, -0.5, -0.04, 0.18, 0.25, 0.18);
      this.box(arm, soldier ? boots : skin, 0, -0.65, -0.04, 0.19, 0.16, 0.2);
      body.add(arm);
      const leg = legs[i];
      leg.position.set(side * 0.18, 0.81, 0);
      this.box(leg, cloth, 0, -0.28, 0, 0.24, 0.55, 0.26);
      this.box(leg, boots, 0, -0.63, -0.055, 0.26, 0.29, 0.36);
      body.add(leg);
    }
    const shadow = new THREE.Mesh(this.plane, this.shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.035;
    shadow.scale.set(1.55, 1.25, 1);
    root.add(shadow);
    const health = new THREE.Group();
    const healthBacking = new THREE.Mesh(
      this.plane,
      this.material(
        new THREE.MeshBasicMaterial({
          color: '#17251f',
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      ),
    );
    healthBacking.scale.set(0.96, 0.1, 1);
    const healthFill = new THREE.Mesh(
      this.plane,
      this.material(
        new THREE.MeshBasicMaterial({
          color: '#bed496',
          depthWrite: false,
        }),
      ),
    );
    healthFill.scale.set(0.9, 0.055, 1);
    healthFill.position.z = 0.01;
    health.add(healthBacking, healthFill);
    health.position.y = 2.2;
    health.visible = false;
    root.add(health);
    if (soldier) {
      arms[0].rotation.set(1.05, 0, 0.75);
      arms[1].rotation.set(1.35, 0, 0.1);
      legs[0].rotation.x = 0.08;
      legs[1].rotation.x = -0.08;
      root.scale.setScalar(1.15);
    }
    // Scenery shadows are baked once; moving actors keep inexpensive contact shadows.
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = false;
    });
    return { root, body, head, arms, legs, skin, cloth, shadow, armor, health, healthFill };
  }

  private buildWeapons(): void {
    const gun = this.surface('#243833', 0.5, 0.7);
    const metal = this.surface('#85938a', 0.4, 0.8);
    const stock = this.surface('#986c47');
    this.gun.position.set(0.33, 1.3, 0);
    this.player.body.add(this.gun);
    for (const id of WEAPON_IDS) {
      const model = new THREE.Group();
      const sniper = id === 'sniper';
      const shotgun = id === 'shotgun';
      this.box(
        model,
        shotgun ? stock : gun,
        0,
        -0.02,
        -0.37,
        shotgun ? 0.21 : 0.15,
        0.2,
        0.54,
        false,
      );
      this.box(
        model,
        metal,
        0,
        0.04,
        sniper ? -0.77 : -0.67,
        shotgun ? 0.105 : 0.07,
        0.07,
        sniper ? 0.34 : 0.14,
        false,
      );
      this.box(model, gun, 0, -0.14, -0.34, 0.11, shotgun ? 0.12 : 0.22, 0.2, false);
      this.box(
        model,
        gun,
        0,
        sniper ? 0.16 : 0.11,
        -0.4,
        sniper ? 0.12 : 0.06,
        sniper ? 0.12 : 0.065,
        sniper ? 0.32 : 0.2,
        false,
      );
      this.box(
        model,
        metal,
        0,
        -0.01,
        sniper ? -0.95 : -0.75,
        shotgun ? 0.14 : 0.1,
        0.11,
        0.08,
        false,
      );
      if (shotgun) this.box(model, stock, 0, -0.025, -0.6, 0.19, 0.15, 0.22, false);
      model.visible = id === 'rifle';
      this.weapons.set(id, model);
      this.gun.add(model);
    }
    this.muzzle.position.set(0, 0, -0.81);
    const flashMaterial = this.material(new THREE.MeshBasicMaterial({ color: '#ffe9a2' }));
    const flash = new THREE.Mesh(this.sphere, flashMaterial);
    flash.scale.set(0.16, 0.16, 0.36);
    this.muzzle.add(flash);
    const outerFlash = new THREE.Mesh(
      this.sphere,
      this.material(
        new THREE.MeshBasicMaterial({
          color: '#f4b74e',
          transparent: true,
          opacity: 0.5,
        }),
      ),
    );
    outerFlash.scale.set(0.28, 0.12, 0.45);
    this.muzzle.add(outerFlash);
    this.muzzle.visible = false;
    this.gun.add(this.muzzle);
  }

  private setWeapon(weapon: WeaponId): void {
    for (const [id, model] of this.weapons) model.visible = id === weapon;
    this.muzzle.position.z = weapon === 'sniper' ? -1.01 : -0.81;
    this.currentWeapon = weapon;
  }

  private buildReticle(): void {
    const material = this.material(
      new THREE.MeshBasicMaterial({
        color: '#f8db98',
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    const ring = new THREE.Mesh(this.geometry(new THREE.RingGeometry(0.38, 0.41, 40)), material);
    ring.rotation.x = -Math.PI / 2;
    this.reticle.add(ring);
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(this.plane, material);
      const angle = (i * Math.PI) / 2;
      tick.position.set(Math.sin(angle) * 0.53, 0, Math.cos(angle) * 0.53);
      tick.rotation.set(-Math.PI / 2, 0, angle);
      tick.scale.set(0.035, 0.16, 1);
      this.reticle.add(tick);
    }
    this.reticle.position.y = 0.065;
    this.scene.add(this.reticle);
    const { range, halfAngle, color } = WEAPONS.shotgun;
    const sector = new THREE.Mesh(
      this.geometry(new THREE.CircleGeometry(range, 24, Math.PI / 2 - halfAngle, halfAngle * 2)),
      this.material(
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.045,
          depthWrite: false,
        }),
      ),
    );
    sector.rotation.x = -Math.PI / 2;
    const edgePoints = [new THREE.Vector3()];
    for (let i = 0; i <= 24; i++) {
      const angle = -halfAngle + (i / 24) * halfAngle * 2;
      edgePoints.push(new THREE.Vector3(Math.sin(angle) * range, 0, -Math.cos(angle) * range));
    }
    edgePoints.push(new THREE.Vector3());
    const edge = new THREE.Line(
      this.geometry(new THREE.BufferGeometry().setFromPoints(edgePoints)),
      this.material(
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
        }),
      ),
    );
    this.spreadGuide.add(sector, edge);
    this.spreadGuide.visible = false;
    this.scene.add(this.spreadGuide);
  }

  private buildEffects(): void {
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(
        this.cylinder,
        this.material(
          new THREE.MeshBasicMaterial({
            color: '#ffe9ab',
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
          }),
        ),
      );
      mesh.visible = false;
      this.scene.add(mesh);
      this.tracers.push({ mesh, life: 0, duration: 0.07, velocity: new THREE.Vector3() });
    }
    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(
        this.sphere,
        this.material(
          new THREE.MeshBasicMaterial({
            color: i % 3 === 0 ? '#cbbf8d' : '#f1cf88',
            transparent: true,
            depthWrite: false,
          }),
        ),
      );
      mesh.visible = false;
      this.scene.add(mesh);
      this.sparks.push({ mesh, life: 0, duration: 0.35, velocity: new THREE.Vector3() });
    }
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(
        this.cylinder,
        this.material(
          new THREE.MeshBasicMaterial({
            color: '#f4d877',
            transparent: true,
            depthWrite: false,
          }),
        ),
      );
      mesh.scale.set(0.15, 0.045, 0.15);
      mesh.visible = false;
      this.scene.add(mesh);
      this.coins.push({ mesh, life: 0, duration: 0.8, velocity: new THREE.Vector3() });
    }
  }

  private buildBosses(): void {
    const dark = this.surface('#273631', 0.8, 0.35);
    const bone = this.surface('#b5ad87');
    const weakRing = this.geometry(new THREE.TorusGeometry(0.58, 0.045, 6, 24));
    const glow = this.material(new THREE.MeshBasicMaterial({ color: '#d5fbaa' }));
    const shell = (
      parent: THREE.Object3D,
      material: THREE.Material,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.sphere, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    for (const kind of ['bulwark', 'brood'] as const) {
      const root = new THREE.Group();
      const body = new THREE.Group();
      const limbs: THREE.Group[] = [];
      const parts = new Map<number, THREE.Group>();
      const armor = this.surface(kind === 'bulwark' ? '#85745b' : '#536d61', 0.65, 0.25);
      root.add(body);
      root.userData.boss = true;
      root.visible = false;
      const core = shell(
        body,
        this.material(new THREE.MeshBasicMaterial({ color: '#f1b166' })),
        0,
        kind === 'bulwark' ? 2.5 : 1.4,
        kind === 'bulwark' ? 0.77 : 1.5,
        kind === 'bulwark' ? 0.36 : 0.58,
        0.28,
        0.2,
      );
      if (kind === 'bulwark') {
        this.box(body, dark, 0, 1.95, 0, 1.65, 1.7, 1.1, false);
        this.box(body, armor, 0, 2.25, 0.5, 1.88, 1.35, 0.44, false);
        this.box(body, armor, 0, 3.24, 0.1, 0.87, 0.83, 0.86, false);
        this.box(body, dark, 0, 3.07, 0.56, 0.66, 0.18, 0.15, false);
        this.box(
          body,
          this.material(new THREE.MeshBasicMaterial({ color: '#efb875' })),
          0,
          3.34,
          0.55,
          0.58,
          0.065,
          0.08,
          false,
        );
        for (const side of [-1, 1]) {
          const arm = new THREE.Group();
          arm.position.set(side * 1.32, 2.6, 0);
          this.box(arm, armor, 0, 0, 0, 1.0, 0.85, 1.16, false);
          this.box(arm, dark, side * 0.12, -0.65, 0.12, 0.58, 1.1, 0.65, false);
          this.box(arm, armor, side * 0.12, -1.18, 0.28, 0.74, 0.66, 0.87, false);
          this.box(arm, bone, 0, 0.48, 0.12, 0.18, 0.14, 0.65, false);
          body.add(arm);
          limbs.push(arm);
          const leg = new THREE.Group();
          leg.position.set(side * 0.6, 1.1, 0);
          this.box(leg, dark, 0, -0.35, 0, 0.62, 0.85, 0.65, false);
          this.box(leg, armor, 0, -0.86, 0.23, 0.75, 0.43, 0.96, false);
          body.add(leg);
          limbs.push(leg);
          this.box(body, bone, side * 0.48, 2.55, 0.745, 0.15, 0.33, 0.06, false);
        }
      } else {
        shell(body, armor, 0, 1.45, -0.1, 1.65, 1.0, 1.75);
        shell(body, dark, 0, 1.08, 1.02, 1.0, 0.6, 0.74);
        for (const side of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            const leg = new THREE.Group();
            leg.position.set(side * 1.13, 1.15, -0.95 + i * 0.92);
            const upper = this.box(leg, armor, side * 0.53, -0.03, 0, 1.32, 0.28, 0.32, false);
            upper.rotation.z = side * 0.19;
            const lower = this.box(leg, dark, side * 1.06, -0.5, 0.11, 0.24, 1.14, 0.28, false);
            lower.rotation.z = side * 0.23;
            this.box(leg, bone, side * 1.18, -1.02, 0.26, 0.28, 0.13, 0.52, false);
            body.add(leg);
            limbs.push(leg);
          }
          const fang = this.box(body, bone, side * 0.51, 0.68, 1.58, 0.16, 0.66, 0.23, false);
          fang.rotation.z = side * 0.4;
        }
        for (let id = 0; id < 3; id++) {
          const part = new THREE.Group();
          shell(part, glow, 0, 0, 0, 0.49, 0.49, 0.49);
          const rim = new THREE.Mesh(weakRing, glow);
          rim.rotation.x = -Math.PI / 4;
          part.add(rim);
          part.traverse((object) => {
            object.userData.bossPart = id;
          });
          root.add(part);
          parts.set(id, part);
        }
      }
      const shadow = new THREE.Mesh(this.plane, this.shadowMaterial);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.03;
      shadow.scale.set(kind === 'bulwark' ? 4.5 : 5.5, 4.2, 1);
      root.add(shadow);
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.castShadow = false;
      });
      this.scene.add(root);
      this.bosses.set(kind, { root, body, limbs, armor, core, parts });
    }
    const warningMaterial = this.material(
      new THREE.MeshBasicMaterial({
        color: '#ef795f',
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      }),
    );
    for (const [inner, outer] of [
      [2.4, 2.48],
      [2.0, 2.06],
    ]) {
      const ring = new THREE.Mesh(
        this.geometry(new THREE.RingGeometry(inner, outer, 56)),
        warningMaterial,
      );
      ring.rotation.x = -Math.PI / 2;
      this.bossWarning.add(ring);
    }
    this.bossWarning.visible = false;
    this.scene.add(this.bossWarning);
    const recovery = new THREE.Mesh(
      this.geometry(new THREE.RingGeometry(0.85, 0.93, 40)),
      this.material(
        new THREE.MeshBasicMaterial({
          color: '#b6edba',
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
        }),
      ),
    );
    recovery.rotation.x = -Math.PI / 2;
    this.recoveryRing.add(recovery);
    this.recoveryRing.visible = false;
    this.scene.add(this.recoveryRing);
  }

  handleEvents(events: GameEvent[]): void {
    for (const event of events) {
      if (event.type === 'shot') {
        if (this.currentWeapon !== event.weapon) this.setWeapon(event.weapon);
        this.flashTime = event.weapon === 'rifle' ? 0.06 : 0.09;
        this.recoil = event.weapon === 'rifle' ? 1 : 1.4;
        this.trauma = Math.max(this.trauma, event.weapon === 'rifle' ? 0.12 : 0.2);
        this.muzzle.scale.setScalar(event.weapon === 'shotgun' ? 1.45 : 1);
        this.gun.rotation.set(0, 0, 0);
        this.player.root.position.set(event.from.x, 0, event.from.z);
        this.player.root.rotation.y = Math.atan2(
          event.from.x - event.to.x,
          event.from.z - event.to.z,
        );
        this.player.root.updateMatrixWorld(true);
        const origin = this.muzzle.getWorldPosition(this.vector);
        if (event.weapon === 'shotgun') {
          const facing = Math.atan2(event.to.x - event.from.x, event.to.z - event.from.z);
          for (let i = 0; i < 5; i++) {
            const angle =
              facing - WEAPONS.shotgun.halfAngle + (i / 4) * WEAPONS.shotgun.halfAngle * 2;
            const to = {
              x: event.from.x + Math.sin(angle) * WEAPONS.shotgun.range,
              y: event.to.y,
              z: event.from.z + Math.cos(angle) * WEAPONS.shotgun.range,
            };
            this.addTracer(origin, event.from, to, event.weapon, false);
          }
        } else {
          this.addTracer(origin, event.from, event.to, event.weapon, event.hit);
        }
      } else if (event.type === 'hit') {
        this.burst(event.at, event.killed ? 8 : 4, '#e4c587');
      } else if (event.type === 'bossBreak') {
        this.burst(event.at, 18, '#c9f4a0', 1.7);
        this.trauma = 0.3;
      } else if (event.type === 'coins') {
        const at = event.at ?? this.player.root.position;
        for (let i = 0; i < Math.min(6, Math.ceil(event.amount / 5)); i++) {
          const coin = this.coins.find((effect) => effect.life <= 0);
          if (!coin) break;
          coin.mesh.position.set(at.x + (Math.random() - 0.5) * 0.4, (at.y ?? 0) + 1.1, at.z);
          coin.mesh.rotation.set(Math.PI / 2, 0, Math.random() * Math.PI);
          coin.velocity.set(
            (Math.random() - 0.5) * 1.3,
            1.6 + Math.random(),
            (Math.random() - 0.5) * 1.3,
          );
          coin.life = coin.duration;
          coin.mesh.visible = true;
        }
      } else if (event.type === 'heal' || event.type === 'revive') {
        this.recoveryTime = event.type === 'revive' ? 1.6 : 1;
        this.burst(
          { x: this.player.root.position.x, y: 0.6, z: this.player.root.position.z },
          14,
          '#b6edba',
        );
      } else if (event.type === 'hurt') {
        this.trauma = 0.5;
      }
    }
  }

  private burst(at: Point, count: number, color: string, size = 1): void {
    for (let i = 0; i < count; i++) {
      const spark = this.sparks.find((effect) => effect.life <= 0);
      if (!spark) break;
      spark.mesh.position.set(at.x, at.y ?? 1.2, at.z);
      spark.velocity.set(
        (Math.random() - 0.5) * 3.5,
        0.5 + Math.random() * 2.2,
        (Math.random() - 0.5) * 3.5,
      );
      spark.mesh.scale.setScalar((0.03 + Math.random() * 0.05) * size);
      (spark.mesh.material as THREE.MeshBasicMaterial).color.set(color);
      spark.duration = 0.2 + Math.random() * 0.2;
      spark.life = spark.duration;
      spark.mesh.visible = true;
    }
  }

  private addTracer(
    origin: THREE.Vector3,
    from: Point,
    to: Point,
    weapon: WeaponId,
    hit: boolean,
  ): void {
    this.direction.set(to.x, to.y ?? (hit ? 1.05 : 1.2), to.z).sub(origin);
    const forwardDistance = this.direction.x * (to.x - from.x) + this.direction.z * (to.z - from.z);
    // A point-blank hit can fall inside the barrel. Keep its hit feedback without a backwards tracer.
    if (forwardDistance <= 0) return;
    const tracer = this.tracers.find((effect) => effect.life <= 0) ?? this.tracers[0];
    const length = this.direction.length();
    tracer.mesh.position.copy(origin).addScaledVector(this.direction, 0.5);
    tracer.mesh.quaternion.setFromUnitVectors(UP, this.direction.normalize());
    const thickness = weapon === 'sniper' ? 0.026 : 0.015;
    tracer.mesh.scale.set(thickness, length, thickness);
    (tracer.mesh.material as THREE.MeshBasicMaterial).color.set(WEAPONS[weapon].color);
    tracer.duration = weapon === 'sniper' ? 0.13 : 0.07;
    tracer.life = tracer.duration;
    tracer.mesh.visible = true;
  }

  private animateZombie(actor: Actor, zombie: Zombie, state: GameState): void {
    const dx = state.player.x - zombie.x;
    const dz = state.player.z - zombie.z;
    actor.root.position.set(zombie.x, 0, zombie.z);
    actor.root.rotation.y = Math.atan2(-dx, -dz);
    const dead = zombie.deadTime >= 0;
    actor.root.userData.alive = !dead;
    const stride =
      this.time *
        (zombie.kind === 'tank'
          ? 3
          : zombie.kind === 'runner'
            ? 8.2
            : zombie.kind === 'small'
              ? 7
              : 5.2) +
      zombie.id * 1.7;
    const attacking = dx * dx + dz * dz < 2.8;
    actor.health.visible = !dead && (zombie.hp < zombie.maxHp || zombie.kind === 'tank');
    actor.health.quaternion.copy(actor.root.quaternion).invert().multiply(this.camera.quaternion);
    const healthRatio = Math.max(0, Math.min(1, zombie.hp / zombie.maxHp));
    actor.healthFill.scale.x = 0.9 * healthRatio;
    actor.healthFill.position.x = -0.45 * (1 - healthRatio);
    actor.skin.emissive.set(zombie.hitTime > 0 ? '#ccb97e' : '#000000');
    actor.cloth.emissive.set(zombie.hitTime > 0 ? '#8d7956' : '#000000');
    actor.skin.emissiveIntensity = actor.cloth.emissiveIntensity = Math.min(1, zombie.hitTime * 7);
    if (dead) {
      const fall = Math.min(1, zombie.deadTime / 0.42);
      actor.body.rotation.x = fall * Math.PI * 0.48;
      actor.body.position.y = -Math.max(0, zombie.deadTime - 1.0) * 0.62;
      actor.body.rotation.z = Math.sin(zombie.id) * fall * 0.2;
      actor.head.rotation.x = -fall * 0.2;
      actor.shadow.scale.set(1.7, 1.3 + fall * 1.4, 1);
      actor.arms[0].rotation.x = actor.arms[1].rotation.x = 0.45 * (1 - fall);
      actor.legs[0].rotation.x = actor.legs[1].rotation.x = 0;
    } else {
      actor.body.position.y = Math.abs(Math.sin(stride)) * 0.045;
      actor.body.rotation.set(
        zombie.hitTime > 0 ? -zombie.hitTime * 0.7 : zombie.kind === 'runner' ? 0.22 : 0.055,
        0,
        Math.sin(stride * 0.5) * 0.04,
      );
      actor.head.rotation.x = 0.12 + Math.sin(stride * 0.5) * 0.04;
      actor.shadow.scale.set(1.55, 1.25, 1);
      actor.legs[0].rotation.x = attacking ? 0.08 : Math.sin(stride) * 0.35;
      actor.legs[1].rotation.x = attacking ? -0.08 : -Math.sin(stride) * 0.35;
      actor.arms[0].rotation.x = attacking
        ? 1.15 + Math.sin(this.time * 7) * 0.42
        : 0.7 + Math.sin(stride) * 0.15;
      actor.arms[1].rotation.x = attacking
        ? 1.15 + Math.sin(this.time * 7 + 0.7) * 0.42
        : 0.85 - Math.sin(stride) * 0.15;
    }
  }

  private animateBoss(state: GameState): void {
    this.boss = state.boss;
    const boss = state.boss;
    for (const [kind, model] of this.bosses)
      model.root.visible = boss?.kind === kind && (boss.deadTime < 0 || boss.deadTime < 1.5);
    this.bossWarning.visible = false;
    if (!boss) return;
    const model = this.bosses.get(boss.kind)!;
    const dead = boss.hp <= 0;
    const moving = boss.z < BOSSES[boss.kind].stopZ - 0.01;
    const warning = !dead && !moving && boss.attackRemaining <= 2;
    const windup = warning ? 1 - Math.max(0, boss.attackRemaining) / 2 : 0;
    model.root.position.set(boss.x, 0, boss.z);
    model.armor.emissive.set(boss.hitTime > 0 ? '#ccb97e' : '#000000');
    model.armor.emissiveIntensity = Math.min(1, boss.hitTime * 7);
    model.body.rotation.set(0, 0, 0);
    model.body.scale.set(1, 1, 1);
    model.body.position.y = dead ? 0 : Math.sin(this.time * 2.2) * 0.035;
    const fall = dead ? Math.min(1, boss.deadTime / 0.8) : 0;
    if (boss.kind === 'bulwark') {
      model.body.rotation.x = -fall * 1.2;
      model.body.position.y -= fall * 0.3;
      model.limbs.forEach((limb, index) => {
        limb.rotation.x = dead
          ? 0
          : index % 2 === 0
            ? -windup * 1.3
            : moving
              ? Math.sin(this.time * 3 + index) * 0.28
              : 0;
      });
    } else {
      model.body.scale.y = 1 - fall * 0.8;
      model.limbs.forEach((limb, index) => {
        limb.rotation.x = dead
          ? fall * 0.35
          : moving
            ? Math.sin(this.time * 5 + index * 1.7) * 0.16
            : windup * 0.14;
      });
      const shielded = boss.parts.some((part) => part.hp > 0);
      (model.core.material as THREE.MeshBasicMaterial).color.set(shielded ? '#536e5b' : '#ffc281');
      for (const [id, partModel] of model.parts) {
        const part = boss.parts.find((candidate) => candidate.id === id);
        partModel.visible = !dead && Boolean(part && part.hp > 0);
        const position = bossPartPosition(boss, id);
        partModel.position.set(position.x - boss.x, position.y, position.z - boss.z);
        partModel.scale.setScalar(1 + Math.sin(this.time * 3 + id) * 0.04);
      }
    }
    this.bossWarning.visible = warning;
    this.bossWarning.position.set(state.player.x, 0.075, state.player.z);
    this.bossWarning.scale.setScalar(1 - windup * 0.22);
    const warningMaterial = (this.bossWarning.children[0] as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    warningMaterial.opacity = 0.42 + windup * 0.25 + Math.sin(this.time * 14) * 0.13;
  }

  render(state: GameState, aim: Point, dt: number): void {
    this.time += dt;
    this.animateBoss(state);
    if (this.currentLevel !== state.level) this.setLevel(state.level);
    if (this.currentWeapon !== state.weapon) this.setWeapon(state.weapon);
    const present = new Set(state.zombies.map((zombie) => zombie.id));
    for (const [id, actor] of this.actors) {
      if (!present.has(id)) {
        actor.root.visible = false;
        this.spareActors.push(actor);
        this.actors.delete(id);
      }
    }
    for (const zombie of state.zombies) {
      let actor = this.actors.get(zombie.id);
      if (!actor) {
        actor = this.spareActors.pop() ?? this.createActor(false, zombie.variant);
        actor.skin.color.set(ZOMBIES[zombie.kind].color);
        actor.cloth.color.set(
          { normal: '#586e5e', tank: '#86594e', runner: '#a08750', small: '#487a72' }[zombie.kind],
        );
        actor.healthFill.material.color.set(ZOMBIES[zombie.kind].color);
        actor.armor.visible = zombie.kind === 'tank';
        actor.body.scale.set(
          zombie.kind === 'tank' ? 1.22 : zombie.kind === 'runner' ? 0.82 : 1,
          1,
          zombie.kind === 'tank' ? 1.12 : 1,
        );
        actor.head.scale.setScalar(zombie.kind === 'small' ? 1.18 : 1);
        actor.root.visible = true;
        actor.root.scale.setScalar(ZOMBIES[zombie.kind].scale * (1 + (zombie.variant % 3) * 0.025));
        actor.root.userData.zombieId = zombie.id;
        this.scene.add(actor.root);
        this.actors.set(zombie.id, actor);
      }
      this.animateZombie(actor, zombie, state);
    }
    this.player.root.position.set(state.player.x, 0, state.player.z);
    this.player.root.rotation.y = Math.atan2(state.player.x - aim.x, state.player.z - aim.z);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.flashTime = Math.max(0, this.flashTime - dt);
    this.trauma = Math.max(0, this.trauma - dt * 2.8);
    this.player.body.position.z = this.recoil * 0.09;
    this.player.body.position.y = Math.sin(this.time * 2) * 0.008;
    this.player.body.rotation.x = -this.recoil * 0.035;
    if (state.phase === 'over')
      this.player.body.rotation.x = Math.min(0.9, this.player.body.rotation.x + 0.6);
    const reloadProgress =
      state.reloadRemaining > 0
        ? 1 -
          state.reloadRemaining /
            (WEAPONS[state.weapon].reloadTime * getReloadMultiplier(state.progress))
        : 0;
    const reloadPose =
      state.reloadRemaining > 0 ? Math.sin(Math.PI * Math.max(0, Math.min(1, reloadProgress))) : 0;
    this.gun.rotation.set(-reloadPose * 0.22, 0, reloadPose * 0.42);
    this.player.arms[0].rotation.set(1.05 - reloadPose * 0.8, 0, 0.75 + reloadPose * 0.2);
    this.player.arms[1].rotation.set(1.35 - reloadPose * 0.16, 0, 0.1);
    this.muzzle.visible = this.flashTime > 0;
    this.muzzle.rotation.z = this.time * 53;
    this.reticle.position.set(aim.x, 0.065, aim.z);
    this.reticle.visible = state.phase === 'playing' || state.phase === 'ready';
    this.aimLine.visible = this.reticle.visible;
    this.spreadGuide.visible = this.reticle.visible && state.weapon === 'shotgun';
    this.spreadGuide.position.set(state.player.x, 0.055, state.player.z);
    this.spreadGuide.rotation.y = this.player.root.rotation.y;
    const aimDistance = Math.hypot(aim.x - state.player.x, aim.z - state.player.z);
    const aimScale =
      state.weapon === 'shotgun' && aimDistance > WEAPONS.shotgun.range
        ? WEAPONS.shotgun.range / aimDistance
        : 1;
    const lineX = state.player.x + (aim.x - state.player.x) * aimScale;
    const lineZ = state.player.z + (aim.z - state.player.z) * aimScale;
    const positions = this.aimLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, state.player.x, 0.06, state.player.z - 0.55);
    positions.setXYZ(1, lineX, 0.06, lineZ);
    positions.needsUpdate = true;
    const distances = this.aimLine.geometry.getAttribute('lineDistance') as THREE.BufferAttribute;
    distances.setX(1, Math.hypot(lineX - state.player.x, lineZ - state.player.z + 0.55));
    distances.needsUpdate = true;
    this.recoveryTime = Math.max(0, this.recoveryTime - dt);
    this.recoveryRing.visible = this.recoveryTime > 0 || state.invulnerable > 0;
    this.recoveryRing.position.set(state.player.x, 0.08, state.player.z);
    this.recoveryRing.scale.setScalar(1 + Math.sin(this.time * 7) * 0.1);

    for (const effect of this.tracers) {
      effect.life = Math.max(0, effect.life - dt);
      effect.mesh.visible = effect.life > 0;
      (effect.mesh.material as THREE.MeshBasicMaterial).opacity = effect.life / effect.duration;
    }
    for (const effect of this.sparks) {
      if (effect.life <= 0) continue;
      effect.life = Math.max(0, effect.life - dt);
      effect.mesh.visible = effect.life > 0;
      effect.mesh.position.addScaledVector(effect.velocity, dt);
      effect.velocity.y -= 7 * dt;
      (effect.mesh.material as THREE.MeshBasicMaterial).opacity = effect.life / effect.duration;
    }
    for (const coin of this.coins) {
      if (coin.life <= 0) continue;
      coin.life = Math.max(0, coin.life - dt);
      coin.mesh.visible = coin.life > 0;
      coin.mesh.position.addScaledVector(coin.velocity, dt);
      coin.velocity.y -= 1.8 * dt;
      coin.mesh.rotation.z += dt * 6;
      (coin.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, coin.life / 0.25);
    }
    this.camera.position.copy(this.cameraPosition);
    this.camera.position.x += Math.sin(this.time * 87) * this.trauma * 0.1;
    this.camera.position.y += Math.cos(this.time * 73) * this.trauma * 0.055;
    this.camera.lookAt(this.cameraTarget);
    this.renderer.render(this.scene, this.camera);
  }

  screenToGround(clientX: number, clientY: number): (Point & { bossPart?: number }) | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // Prefer a visible living body over the ground behind it. The nearest opaque scenery
    // remains an occluder, so this does not select enemies through containers or walls.
    const targets = [...this.aimOccluders];
    for (const actor of this.actors.values()) {
      if (!actor.root.visible || !actor.root.userData.alive) continue;
      actor.body.traverseVisible((object) => {
        if (object instanceof THREE.Mesh) targets.push(object);
      });
    }
    const boss = this.boss;
    if (boss && boss.hp > 0) {
      this.bosses.get(boss.kind)!.root.traverseVisible((object) => {
        if (
          object instanceof THREE.Mesh &&
          !Array.isArray(object.material) &&
          !object.material.transparent
        )
          targets.push(object);
      });
    }
    const nearest = this.raycaster.intersectObjects(targets, false)[0];
    if (nearest) {
      let object = nearest.object;
      while (object.parent && object.parent !== this.scene) object = object.parent;
      const actor = this.actors.get(object.userData.zombieId as number);
      if (actor) return { x: actor.root.position.x, z: actor.root.position.z };
      if (object.userData.boss && boss && boss.hp > 0) {
        const part = nearest.object.userData.bossPart as number | undefined;
        if (
          part !== undefined &&
          boss.parts.some((candidate) => candidate.id === part && candidate.hp > 0)
        )
          return bossPartPosition(boss, part);
        return { x: boss.x, y: 1.5, z: boss.z };
      }
    }
    if (!this.raycaster.ray.intersectPlane(this.ground, this.intersection)) return null;
    return { x: this.intersection.x, z: this.intersection.z };
  }

  bossPartPositions(): { id: number; x: number; y: number; z: number }[] {
    if (!this.boss || this.boss.hp <= 0) return [];
    const model = this.bosses.get(this.boss.kind)!;
    model.root.updateMatrixWorld(true);
    return [...model.parts]
      .filter(
        ([id, part]) =>
          part.visible &&
          this.boss!.parts.some((candidate) => candidate.id === id && candidate.hp > 0),
      )
      .map(([id, part]) => {
        part.getWorldPosition(this.vector);
        return { id, x: this.vector.x, y: this.vector.y, z: this.vector.z };
      });
  }

  project(point: Point): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    this.vector.set(point.x, point.y ?? 0, point.z).project(this.camera);
    return {
      x: rect.left + (this.vector.x + 1) * 0.5 * this.width,
      y: rect.top + (1 - this.vector.y) * 0.5 * this.height,
    };
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.camera.aspect = this.width / this.height;
    this.camera.fov = this.camera.aspect < 1 ? 58 : 43;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
  }

  clearEffects(): void {
    this.flashTime = this.recoil = this.trauma = this.recoveryTime = 0;
    this.muzzle.visible = false;
    this.recoveryRing.visible = false;
    this.bossWarning.visible = false;
    this.boss = null;
    for (const model of this.bosses.values()) model.root.visible = false;
    for (const effect of [...this.tracers, ...this.sparks, ...this.coins]) {
      effect.life = 0;
      effect.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.renderer.dispose();
  }
}
