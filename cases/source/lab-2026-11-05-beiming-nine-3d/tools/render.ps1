param([ValidateSet("pilot","final","clay")][string]$Mode="final", [string]$Scenes="01,02,03,04,05,06,07,08,09", [string]$Tag="latest")
$ErrorActionPreference="Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:BEIMING_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:BEIMING_ANGLE="vulkan"
Write-Host "RTX workload status (please avoid concurrent jobs):"
nvidia-smi --query-gpu=name,utilization.gpu,memory.used --format=csv,noheader
$RenderArgs=@("tools/render.mjs","--scenes",$Scenes,"--tag",$Tag)
if($Mode -eq "pilot"){$RenderArgs += "--pilot"}
if($Mode -eq "clay"){$RenderArgs += "--qa"}
node @RenderArgs
exit $LASTEXITCODE
