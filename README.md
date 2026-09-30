# 最后防线 · LAST LINE

使用 Three.js 构建的浏览器 3D 僵尸射击 MVP。主角固定站位，鼠标瞄准、按住左键连射；僵尸持续从前方靠近，击杀后倒地。一个场景、固定难度，没有关卡或成长系统。

## 本地运行

需要 Node.js 22.12+ 和支持 WebGL 2 的现代浏览器。

```sh
npm ci
npm run dev
```

打开终端显示的 `http://127.0.0.1:5173`。默认仅绑定本机，首次点击“进入战斗”后启用音效。

## 操作

| 操作           | 效果             |
| -------------- | ---------------- |
| 移动鼠标       | 瞄准地面目标位置 |
| 按住鼠标左键   | 持续开火         |
| Esc / P        | 暂停或继续       |
| R              | 结算后重开       |
| 右上角声音按钮 | 静音或恢复声音   |

失焦和切换标签页自动暂停，返回后点击继续；后台时间不计入战斗。死亡后可以再次出击，重开清空血量、成绩、尸体和特效。

首版以电脑浏览器验收。页面提供窄屏布局和 Pointer Events 输入，手机上的操作及性能仍需后续设备专项验收。

## 验证与构建

```sh
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:soak
npm run preview
```

构建产物位于 `dist/`，可由静态 HTTP 服务提供。GitHub Actions 对 PR 执行单元测试、类型检查/构建和 Chromium 交互测试；本仓库不含自动部署。

`test:soak` 自动启动临时开发服务器，执行 5 分钟真实浏览器射击并检查活体数量、尸体、特效及浏览器错误。它使用 Chromium 的 SwiftShader 软件渲染，输出墙钟时长、实际游戏时长和 FPS 数据，不代表设备硬件加速性能。可用 `SOAK_SECONDS=30` 缩短本地调试轮次。

## 实现

- `src/game/simulation.ts`：独立于渲染的战斗状态与计时；射线与圆相交决定最近命中目标。
- `src/game/world.ts`：Three.js 场景、低多边形角色、动作与有限容量特效池。
- `src/game/audio.ts`：Web Audio 合成音效，无外部音频资源。
- `src/main.ts`：输入、页面生命周期、对局界面和主循环。
- `src/game/types.ts`：共享状态与初始数值。

步枪每秒 5 发、单发伤害 25；普通僵尸生命 75，接近后每秒造成 10 点伤害。活体上限 30，尸体 1.5 秒后回收。角色、场景和声音均由代码生成，无模型下载、远程字体、账号、后端或持久化数据。

开发服务器的 `/?inspect` 提供只读 `window.__game.snapshot()` 与 `project()`，用于浏览器验收。生产构建移除此检查接口。

范围与验收记录见 [Issue #1](https://github.com/lam-guo/zoombie/issues/1)。
