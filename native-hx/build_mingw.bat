@echo off
rem Build the heat exchanger kernel (headless, shares native/pid.cpp with the tank kernel).
rem g++ 需已在 PATH 中；若 MinGW 装在别处，先执行：
rem     set MINGW_BIN=<你的MinGW目录>\bin
rem 再运行本脚本。
setlocal
if defined MINGW_BIN set PATH=%MINGW_BIN%;%PATH%
pushd "%~dp0"
if not exist build mkdir build
g++ -O2 -std=c++17 -Wall -Wextra -static -o build\HxEngine.exe engine-hx.cpp hx_model.cpp hx_score.cpp ..\native\pid.cpp
if errorlevel 1 (
  echo HxEngine build FAILED
  popd
  exit /b 1
)
g++ -O2 -std=c++17 -Wall -Wextra -static -o build\selftest_hx.exe selftest_hx.cpp hx_model.cpp ..\native\pid.cpp
if errorlevel 1 (
  echo selftest_hx build FAILED
  popd
  exit /b 1
)
echo Built build\HxEngine.exe and build\selftest_hx.exe
popd
endlocal
