$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'render.ps1')
if($LASTEXITCODE -ne 0){throw 'Rendering failed'}
python (Join-Path $PSScriptRoot 'finish-film.py')
if($LASTEXITCODE -ne 0){throw 'Delivery verification failed'}
