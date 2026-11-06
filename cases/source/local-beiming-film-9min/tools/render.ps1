$ErrorActionPreference='Stop'
$env:BEIMING_CHROME='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:BEIMING_ANGLE='vulkan'
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$env:Path='C:\Program Files\nodejs;D:\Apps\FFmpeg\ffmpeg-9.0.2-full_build\bin;D:\beiming\tools\venv\Scripts;'+$env:Path
Set-Location (Split-Path $PSScriptRoot -Parent)
$gpuUse=(& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | Select-Object -First 1).Trim()
if([int]$gpuUse -gt 10){throw 'GPU正忙；请等待，不会停止其他任务。'}
foreach($port in @(8188,8189)){
 $queue=$null
 try{$queue=Invoke-RestMethod "http://127.0.0.1:$port/queue" -TimeoutSec 2}catch{}
 if($queue -and (($queue.queue_running.Count -gt 0)-or($queue.queue_pending.Count -gt 0))){throw 'ComfyUI有排队任务；请等待。'}
}
if($args[0] -eq 'probe'){node tools/probe.mjs @($args | Select-Object -Skip 1);exit $LASTEXITCODE}
node tools/render-film.mjs --workers 4 --size 3840x2080 @args
if($LASTEXITCODE -ne 0){throw '逐帧渲染失败'}
