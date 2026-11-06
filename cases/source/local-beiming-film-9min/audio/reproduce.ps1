# Execute with an existing Python venv; no GPU or execution-policy changes.
$ErrorActionPreference='Stop'
$py='D:\beiming\tools\venv\Scripts\python.exe'
$env:PYTHONIOENCODING='utf-8'
$env:OMP_NUM_THREADS='2'
& $py "$PSScriptRoot\make_voices.py" --root $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'TTS failed' }
& $py "$PSScriptRoot\produce_audio.py" --stage all --samples "$PSScriptRoot\samples"
if ($LASTEXITCODE -ne 0) { throw 'Sound production failed' }
& $py "$PSScriptRoot\verify_audio.py"
if ($LASTEXITCODE -ne 0) { throw 'Audio verification failed' }
