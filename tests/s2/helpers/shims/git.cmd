@echo off
"%SDLC_S2_NODE%" "%~dp0shim-runner.mjs" git %*
exit /b %ERRORLEVEL%
