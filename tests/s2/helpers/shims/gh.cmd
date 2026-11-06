@echo off
"%SDLC_S2_NODE%" "%~dp0shim-runner.mjs" gh %*
exit /b %ERRORLEVEL%
