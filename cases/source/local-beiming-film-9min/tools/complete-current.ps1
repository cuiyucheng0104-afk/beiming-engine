$ErrorActionPreference='Stop'
$env:BEIMING_ANGLE='vulkan'
$env:BEIMING_CHROME='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$env:Path='C:\Program Files\nodejs;D:\Apps\FFmpeg\ffmpeg-9.0.2-full_build\bin;D:\beiming\tools\venv\Scripts;'+$env:Path
Set-Location (Split-Path $PSScriptRoot -Parent)
$key='98dc4a02cd660ac4fffee792d9427e0150b12fc2b1743609497ff73e01d2ddad'
$deadline=(Get-Date).AddHours(2)
while($true){
 $p=Get-Content out\chunks-3840x2080\progress.json -Raw | ConvertFrom-Json
 if($p.key -ne $key){throw 'Render version changed'}
 if($p.finished -and (Test-Path out\video_4k.mp4)){break}
 if((Get-Date) -gt $deadline){throw 'Render wait timed out'}
 Start-Sleep -Seconds 5
}
Write-Output 'Full render finished; preparing delivery.'
while($true){
 $busy=[int]((& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | Select-Object -First 1).Trim()) -gt 10
 foreach($port in @(8188,8189)){
  $q=$null;try{$q=Invoke-RestMethod "http://127.0.0.1:$port/queue" -TimeoutSec 2}catch{}
  if($q -and (($q.queue_running.Count -gt 0)-or($q.queue_pending.Count -gt 0))){$busy=$true}
 }
 if(-not $busy){break}
 if((Get-Date) -gt $deadline){throw 'GPU busy beyond deadline'}
 Start-Sleep -Seconds 5
}
python tools/finish-film.py
if($LASTEXITCODE -ne 0){throw 'Packaging or delivery check failed'}
python tools/review-delivery.py
if($LASTEXITCODE -ne 0){throw 'Encoded-frame export failed'}
Write-Output 'READY_TO_COPY'
