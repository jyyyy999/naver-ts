@echo off
rem Runs the Gmarket buyer without npm, so options pass through as-is:   .\gm --pin 123456
rem Windows PowerShell 5.1 drops the "--" in "npm run gm -- --pin 123456", and npm then
rem swallows --pin. Nothing is swallowed here.
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\gmarket\cli.ts" %*
