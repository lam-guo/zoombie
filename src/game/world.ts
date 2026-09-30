import * as THREE from 'three';
import type { GameEvent, GameState, Point, Zombie } from './types';

type Actor = {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  arms: [THREE.Group, THREE.Group];
  legs: [THREE.Group, THREE.Group];
  skin: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  shadow: THREE.Mesh;
};

type Effect = {
  mesh: THREE.Mesh;
  life: number;
  duration: number;
  velocity: THREE.Vector3;
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
  private readonly player: Actor;
  private readonly muzzle = new THREE.Group();
  private readonly reticle = new THREE.Group();
  private readonly aimLine: THREE.Line;
  private readonly cube = this.geometry(new THREE.BoxGeometry(1, 1, 1));
  private readonly cylinder = this.geometry(new THREE.CylinderGeometry(1, 1, 1, 8));
  private readonly sphere = this.geometry(new THREE.IcosahedronGeometry(1, 0));
  private readonly plane = this.geometry(new THREE.PlaneGeometry(1, 1));
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly cameraPosition = new THREE.Vector3(7.5, 25, 27);
  private readonly cameraTarget = new THREE.Vector3(0, 0, -4.5);
  private time = 0;
  private flashTime = 0;
  private recoil = 0;
  private trauma = 0;
  private width = 1;
  private height = 1;

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

    const sky = new THREE.HemisphereLight('#d4e3d0', '#29362e', 2.4);
    this.scene.add(sky);
    const sun = new THREE.DirectionalLight('#f5dfb5', 3.1);
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
    this.buildRifle();
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
    this.resize();
  }

  get info(): { drawCalls: number; triangles: number; effects: number } {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      effects:
        this.tracers.filter((effect) => effect.life > 0).length +
        this.sparks.filter((effect) => effect.life > 0).length +
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
    const warmGlow = this.material(new THREE.MeshBasicMaterial({ color: '#ffda85' }));
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
    const zoneLabel = this.material(
      new THREE.MeshStandardMaterial({
        map: this.textTexture('SECTOR 07', '#a9b4a0'),
        transparent: true,
        roughness: 1,
        depthWrite: false,
        opacity: 0.36,
      }),
    );
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
    return { root, body, head, arms, legs, skin, cloth, shadow };
  }

  private buildRifle(): void {
    const gun = this.surface('#243833', 0.5, 0.7);
    const metal = this.surface('#85938a', 0.4, 0.8);
    const body = this.player.body;
    this.box(body, gun, 0.33, 1.28, -0.37, 0.15, 0.2, 0.54, false);
    this.box(body, metal, 0.33, 1.34, -0.67, 0.07, 0.07, 0.14, false);
    this.box(body, gun, 0.33, 1.16, -0.34, 0.11, 0.22, 0.2, false);
    this.box(body, gun, 0.33, 1.41, -0.4, 0.06, 0.065, 0.2, false);
    this.box(body, metal, 0.33, 1.29, -0.75, 0.1, 0.11, 0.08, false);
    this.muzzle.position.set(0.33, 1.3, -0.81);
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
    body.add(this.muzzle);
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
  }

  handleEvents(events: GameEvent[]): void {
    for (const event of events) {
      if (event.type === 'shot') {
        this.flashTime = 0.06;
        this.recoil = 1;
        this.trauma = Math.max(this.trauma, 0.12);
        this.player.root.position.set(event.from.x, 0, event.from.z);
        this.player.root.rotation.y = Math.atan2(
          event.from.x - event.to.x,
          event.from.z - event.to.z,
        );
        this.player.root.updateMatrixWorld(true);
        const origin = this.muzzle.getWorldPosition(this.vector);
        this.direction.set(event.to.x, event.hit ? 1.05 : 1.2, event.to.z).sub(origin);
        const forwardDistance =
          this.direction.x * (event.to.x - event.from.x) +
          this.direction.z * (event.to.z - event.from.z);
        // A point-blank hit can fall inside the barrel. Keep its hit feedback without a backwards tracer.
        if (forwardDistance <= 0) continue;
        const tracer = this.tracers.find((effect) => effect.life <= 0) ?? this.tracers[0];
        const length = this.direction.length();
        tracer.mesh.position.copy(origin).addScaledVector(this.direction, 0.5);
        tracer.mesh.quaternion.setFromUnitVectors(UP, this.direction.normalize());
        tracer.mesh.scale.set(0.015, length, 0.015);
        tracer.life = tracer.duration;
        tracer.mesh.visible = true;
      } else if (event.type === 'hit') {
        for (let i = 0; i < (event.killed ? 8 : 4); i++) {
          const spark = this.sparks.find((effect) => effect.life <= 0);
          if (!spark) break;
          spark.mesh.position.set(event.at.x, 1.2, event.at.z);
          spark.velocity.set(
            (Math.random() - 0.5) * 3.5,
            0.5 + Math.random() * 2.2,
            (Math.random() - 0.5) * 3.5,
          );
          spark.mesh.scale.setScalar(0.03 + Math.random() * 0.05);
          spark.duration = 0.2 + Math.random() * 0.2;
          spark.life = spark.duration;
          spark.mesh.visible = true;
        }
      } else if (event.type === 'hurt') {
        this.trauma = 0.5;
      }
    }
  }

  private animateZombie(actor: Actor, zombie: Zombie, state: GameState): void {
    const dx = state.player.x - zombie.x;
    const dz = state.player.z - zombie.z;
    actor.root.position.set(zombie.x, 0, zombie.z);
    actor.root.rotation.y = Math.atan2(-dx, -dz);
    const dead = zombie.deadTime >= 0;
    const stride = this.time * 5.2 + zombie.id * 1.7;
    const attacking = dx * dx + dz * dz < 2.8;
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
        zombie.hitTime > 0 ? -zombie.hitTime * 0.7 : 0.055,
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

  render(state: GameState, aim: Point, dt: number): void {
    this.time += dt;
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
        actor.skin.color.set(['#91a37b', '#839b85', '#a1a084'][zombie.variant % 3]);
        actor.cloth.color.set(['#586e5e', '#78715b', '#566d70'][zombie.variant % 3]);
        actor.root.visible = true;
        actor.root.scale.setScalar(1 + (zombie.variant % 3) * 0.065);
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
    this.muzzle.visible = this.flashTime > 0;
    this.muzzle.rotation.z = this.time * 53;
    this.reticle.position.set(aim.x, 0.065, aim.z);
    this.reticle.visible = state.phase === 'playing' || state.phase === 'ready';
    this.aimLine.visible = this.reticle.visible;
    const positions = this.aimLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, state.player.x, 0.06, state.player.z - 0.55);
    positions.setXYZ(1, aim.x, 0.06, aim.z);
    positions.needsUpdate = true;
    const distances = this.aimLine.geometry.getAttribute('lineDistance') as THREE.BufferAttribute;
    distances.setX(1, Math.hypot(aim.x - state.player.x, aim.z - state.player.z + 0.55));
    distances.needsUpdate = true;

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
    this.camera.position.copy(this.cameraPosition);
    this.camera.position.x += Math.sin(this.time * 87) * this.trauma * 0.1;
    this.camera.position.y += Math.cos(this.time * 73) * this.trauma * 0.055;
    this.camera.lookAt(this.cameraTarget);
    this.renderer.render(this.scene, this.camera);
  }

  screenToGround(clientX: number, clientY: number): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.ground, this.intersection)) return null;
    return { x: this.intersection.x, z: this.intersection.z };
  }

  project(point: Point): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    this.vector.set(point.x, 0, point.z).project(this.camera);
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
    this.flashTime = this.recoil = this.trauma = 0;
    this.muzzle.visible = false;
    for (const effect of [...this.tracers, ...this.sparks]) {
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
