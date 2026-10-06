# Packages exactly the files tauri.conf.json's bundle.resources ships into
# build-binaries-win-x64.zip, for the release workflow (.github/workflows/release.yml) to fetch -
# binaries/ itself is gitignored. Run from the repo root:
#
#   powershell -File scripts/package-build-binaries.ps1
#
# Then upload the zip to a new GitHub Release tag (build-binaries-v2, ...) and update
# BINARIES_URL and BINARIES_SHA256 in release.yml together.

$ErrorActionPreference = "Stop"
$src = "src-tauri/binaries"
$stage = Join-Path $env:TEMP "briefcast-build-binaries"
$zip = "build-binaries-win-x64.zip"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force "$stage/binaries/ffmpeg", "$stage/binaries/whisper" | Out-Null

# Keep in step with tauri.conf.json's resources list.
Copy-Item "$src/ffmpeg/ffmpeg.exe", "$src/ffmpeg/ffprobe.exe" "$stage/binaries/ffmpeg/"
Copy-Item -Recurse "$src/heif", "$src/rnnoise" "$stage/binaries/"
Copy-Item "$src/whisper/*.exe", "$src/whisper/*.dll" "$stage/binaries/whisper/"

if (Test-Path $zip) { Remove-Item $zip }
# tar.exe (built into Windows 10+) rather than Compress-Archive: Windows PowerShell's
# Compress-Archive stores paths with backslashes, which standard unzip tools reject.
# Full path so a Git-for-Windows GNU tar on PATH (which can't write zips) is never picked up.
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C $stage binaries
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Write-Host "$zip  $hash"
