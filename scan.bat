@echo off
rem =====================================================================
rem  OptionDesk 每日扫描一键脚本（Windows）
rem  ---------------------------------------------------------------
rem  做四件事：
rem    1. python scan.py    —— 抓全市场 + 评分（约 4-5 分钟，需联网）
rem    2. python review.py  —— 績效覆盤（跟進過往建議）
rem    3. python build.py   —— 把扫描结果 + 績效 + PLTR 快照烤入单档 HTML
rem    4. copy 到工作目录    —— H:\workbuddy輸出\眾包數據\OptionDesk.html
rem
rem  前置要求（只需做一次）：
rem    - Python 3.10+（python.exe 在 PATH）
rem    - Node.js 18+（node.exe 在 PATH，评分引擎用）
rem    - pip install requests
rem
rem  每日自动：任务计划程序 -> 创建基本任务 -> 每天（建议收市后 1 小时，
rem  美股 04:00 香港时间）-> 启动程序 -> 指住呢个 scan.bat
rem =====================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo === OptionDesk 每日扫描 %date% %time% ===
echo.

rem ---- 1. 扫描（抓取 + 评分）----
python scan.py --top 150 --workers 8
if errorlevel 1 goto :fail

rem ---- 2. 績效覆盤（跟進過往可出手建議，失敗都照行）----
python review.py || echo 覆盤失敗，用舊績效繼續

rem ---- 3. 烤入单档 HTML（有快照就烤，无就纯扫描版）----
if exist snapshot-PLTR.json (
  python build.py --scan scan\latest.json --snapshot snapshot-PLTR.json --perf scan\perf.json
) else (
  python build.py --scan scan\latest.json --perf scan\perf.json
)
if errorlevel 1 goto :fail

rem ---- 4. 复制到工作目录（路径唔同就改下面）----
set "DEST=H:\workbuddy輸出\眾包數據"
if exist "%DEST%" (
  copy /y OptionDesk.html "%DEST%\OptionDesk.html" >nul
  echo 已复制到 %DEST%\OptionDesk.html
)

echo.
echo === 完成！双击 OptionDesk.html 即可睇今日机会 ===
exit /b 0

:fail
echo.
echo === 扫描失败，睇上面的错误信息 ===
exit /b 1
