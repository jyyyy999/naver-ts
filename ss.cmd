@echo off
rem Runs the CLI without npm, so options pass through as-is:   .\ss --pin 123456
rem Windows PowerShell 5.1 drops the "--" in "npm start -- --pin 123456", and npm then
rem swallows --pin. cli.ts recovers most of those, but not value options (--interval 5)
rem or --help. Nothing is swallowed here.
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\cli.ts" %*
