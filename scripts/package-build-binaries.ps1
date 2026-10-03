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
Compress-Archive -Path "$stage/binaries" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Write-Host "$zip  $hash"
