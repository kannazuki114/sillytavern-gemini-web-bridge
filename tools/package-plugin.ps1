$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$outputDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$archivePath = Join-Path $outputDir "gemini-web-bridge-$version.zip"
$files = @('index.mjs', 'package.json', 'package-lock.json', 'config.json', 'README.md', 'AUDIT.md', 'server.mjs', 'start-chrome-debug.bat', 'start-gemini.bat', 'start-gemini-app.bat', 'start-gemini-desktop.bat', 'start-bridge.bat', 'start-bridge-gemini.bat')
foreach ($folder in @('lib', 'backends', 'tools', 'test')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -File -Recurse | ForEach-Object { [System.IO.Path]::GetRelativePath($projectRoot, $_.FullName) }
}
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite)
$zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $entryName = 'gemini-web-bridge/' + $file.Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $projectRoot $file), $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
    $stream.Dispose()
}
Write-Output $archivePath
