@echo off
rem 本地（Windows）启动云仿真网关：先保证 native\build\YunEngine.exe 已编译
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8080
if "%YUN_ENGINE%"=="" set YUN_ENGINE=%~dp0native\build\YunEngine.exe
if not exist "%YUN_ENGINE%" (
  echo 未找到仿真内核：%YUN_ENGINE%
  echo 请先运行：npm run build:engine
  exit /b 1
)
echo 访问地址：http://127.0.0.1:%PORT%
node server\server.js
