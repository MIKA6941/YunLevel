#!/usr/bin/env node
// 编译 C++ 仿真内核。
//   tank : native/engine.cpp + model.cpp + pid.cpp + score.cpp -> native/build/YunEngine.exe
//   hx   : native-hx/engine-hx.cpp + hx_model.cpp + hx_score.cpp + native/pid.cpp
//          -> native-hx/build/HxEngine.exe
// 两个内核共用同一份 native/pid.cpp，保证 DCS 口径 Ki = 1/Ti 只有一个实现。
// hx 目标缺失源文件时只跳过，不影响液位内核的构建（零回归）。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const targets = [
  {
    name: 'tank',
    outFile: isWin
      ? path.join(root, 'native', 'build', 'YunEngine.exe')
      : path.join(root, 'bin', 'YunEngine'),
    sources: ['engine.cpp', 'model.cpp', 'pid.cpp', 'score.cpp']
      .map((name) => path.join(root, 'native', name)),
    required: true,
  },
  {
    name: 'hx',
    outFile: isWin
      ? path.join(root, 'native-hx', 'build', 'HxEngine.exe')
      : path.join(root, 'bin', 'HxEngine'),
    sources: [
      path.join(root, 'native-hx', 'engine-hx.cpp'),
      path.join(root, 'native-hx', 'hx_model.cpp'),
      path.join(root, 'native-hx', 'hx_score.cpp'),
      path.join(root, 'native', 'pid.cpp'),
    ],
    required: false,
  },
];

// 编译器候选：优先用 PATH 里的 g++；Windows 上若 MinGW 不在 PATH，
// 可用环境变量 MINGW_BIN 指向 MinGW 的 bin 目录（例如 set MINGW_BIN=<你的MinGW目录>\bin）
const candidates = isWin
  ? ['g++', process.env.MINGW_BIN ? path.join(process.env.MINGW_BIN, 'g++.exe') : null].filter(Boolean)
  : ['g++', 'c++'];

function build(target, compiler) {
  const outDir = path.dirname(target.outFile);
  fs.mkdirSync(outDir, { recursive: true });
  // Windows 需要 -static，否则网关启动内核时会找不到 MinGW 运行库（0xC0000135）
  const linkFlags = isWin ? ['-static'] : ['-static-libstdc++', '-static-libgcc'];
  const args = ['-O2', '-std=c++17', '-Wall', '-Wextra', ...linkFlags, '-o', target.outFile, ...target.sources];
  // MinGW 需要把编译器所在目录放进 PATH，否则找不到 cc1plus / as / collect2
  const env = { ...process.env };
  const binDir = path.dirname(compiler);
  if (binDir && binDir !== '.' && binDir !== '') {
    env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
    env.Path = env.PATH;
  }
  return spawnSync(compiler, args, { stdio: 'inherit', env });
}

let ok = false;
let lastError = '';
for (const compiler of candidates) {
  let allBuilt = true;
  let missingRequired = false;
  for (const target of targets) {
    const missing = target.sources.filter((file) => !fs.existsSync(file));
    if (missing.length) {
      if (target.required) {
        console.error(`缺少源文件：${missing.join(', ')}`);
        missingRequired = true;
        break;
      }
      console.warn(`跳过 ${target.name} 内核：缺少 ${missing.join(', ')}`);
      continue;
    }
    const result = build(target, compiler);
    if (result.error) {
      lastError = String(result.error.message || result.error);
      allBuilt = false;
      break;
    }
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
    console.log(`已生成仿真内核：${target.outFile}`);
  }
  if (missingRequired) process.exit(1);
  if (allBuilt) {
    ok = true;
    break;
  }
}

if (!ok) {
  console.error(`编译失败：${lastError}`);
  console.error('请确认已安装 g++（Windows 可安装 MinGW-w64，并加入 PATH）。');
  process.exit(1);
}
