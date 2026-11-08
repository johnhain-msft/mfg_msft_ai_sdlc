@echo off
"%SDLC_S2_NODE%" "%~dp0shim-runner.mjs" npm %*
exit /b %ERRORLEVEL%
