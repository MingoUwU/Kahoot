@echo off
echo ===========================================
echo   Packaging KQH Kahoot AI Extension...
echo ===========================================

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Compress-Archive -Path 'manifest.json', 'background.js', 'content.js', 'content-bridge.js', 'popup.html', 'popup.js', 'icons', 'README.md' -DestinationPath 'KQH-Kahoot-AI.zip' -Force"

if exist "KQH-Kahoot-AI.zip" (
    echo [SUCCESS] Package created: KQH-Kahoot-AI.zip
) else (
    echo [ERROR] Failed to create package.
)
pause
