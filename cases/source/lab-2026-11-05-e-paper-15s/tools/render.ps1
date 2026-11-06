$ErrorActionPreference = 'Stop'
$env:BEIMING_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:BEIMING_ANGLE = 'vulkan'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:Path = 'C:\Program Files\nodejs;D:\Apps\FFmpeg\ffmpeg-9.0.2-full_build\bin;D:\beiming\tools\venv\Scripts;' + $env:Path
Set-Location (Split-Path $PSScriptRoot -Parent)
$gpuUse = (& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | Select-Object -First 1).Trim()
if ([int]$gpuUse -gt 10) { throw 'GPU 正忙，请待其他任务完成后再运行；不会停止其他进程。' }
foreach ($port in @(8188,8189)) {
  $queue = $null
  try {$queue = Invoke-RestMethod "http://127.0.0.1:$port/queue" -TimeoutSec 2} catch {}
  if ($queue -and (($queue.queue_running.Count -gt 0) -or ($queue.queue_pending.Count -gt 0))) { throw 'ComfyUI 有排队任务，请待其完成后运行。' }
}
if ($args[0] -eq 'probe') { node tools/probe.mjs; exit $LASTEXITCODE }
node tools/probe.mjs 2.8 7.4 11.0
if ($LASTEXITCODE -ne 0) {throw 'GPU 或关键帧探针失败'}
node engine/render/video.mjs . --size 3840x2080 --fps 24 --workers 4 --out out/video_4k.mp4
if ($LASTEXITCODE -ne 0) {throw '逐帧渲染失败'}
if (!(($args -contains 'reuse-audio') -and (Test-Path 'out/mix.wav'))) {
  python audio/make.py
  if ($LASTEXITCODE -ne 0) {throw '声音制作失败'}
}
ffmpeg -v error -nostdin -y -i out/video_4k.mp4 -i out/mix.wav -vf 'scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p' -c:v libx264 -preset medium -crf 16 -colorspace bt709 -color_trc bt709 -color_primaries bt709 -color_range tv -c:a aac -b:a 256k -ar 48000 -t 15 -movflags +faststart delivery/paper-rivers_E_4k.mp4
if ($LASTEXITCODE -ne 0) {throw '音画封装失败'}
ffmpeg -v error -nostdin -y -i delivery/paper-rivers_E_4k.mp4 -vf scale=1920:1040 -pix_fmt yuv420p -c:v libx264 -preset medium -crf 19 -colorspace bt709 -color_trc bt709 -color_primaries bt709 -color_range tv -c:a copy -movflags +faststart delivery/paper-rivers_E_preview.mp4
if ($LASTEXITCODE -ne 0) {throw '预览封装失败'}
python tools/deliver.py
if ($LASTEXITCODE -ne 0) {throw '成片核查失败'}
