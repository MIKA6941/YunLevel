#!/usr/bin/env node
// 启动前检查：仿真内核是否已编译。缺失时自动编译，编译不了就给出清晰指引。
// 由 package.json 的 prestart 钩子在 `npm start` 之前自动执行。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const targets = isWin
  ? [
      path.join(root, 'native', 'build', 'YunEngine.exe'),
      path.join(root, 'native-hx', 'build', 'HxEngine.exe'),
    ]
  : [
      path.join(root, 'bin', 'YunEngine'),
      path.join(root, 'bin', 'HxEngine'),
    ];

const missing = targets.filter((file) => !fs.existsSync(file));
if (missing.length === 0) process.exit(0);

console.log('[ensure-engine] 仿真内核尚未编译，正在自动编译……');
const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-engine.js')], {
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log('[ensure-engine] 内核编译完成。');
  process.exit(0);
}

console.error('');
console.error('[ensure-engine] 内核编译失败：本机没有可用的 g++。');
console.error('  方案一：安装支持 C++17 的 g++（Windows 可装 MinGW-w64），');
console.error('          并确保 g++ 在 PATH 中，或设置 MINGW_BIN 指向 MinGW 的 bin 目录，');
console.error('          然后重新执行 npm start。');
console.error('  方案二：改用 Docker，镜像内会自动编译内核：');
console.error('          docker compose up -d --build');
process.exit(1);
