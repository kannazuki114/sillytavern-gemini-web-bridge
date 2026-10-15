$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
& node (Join-Path $PSScriptRoot 'build-extension.mjs')
if ($LASTEXITCODE -ne 0) { throw '前端扩展构建失败' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$outputDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$archivePath = Join-Path $outputDir "gemini-web-bridge-$version.zip"
$files = @('manifest.json', 'index.js', 'settings.html', 'style.css', 'INSTALL.md', 'index.mjs', 'package.json', 'package-lock.json', 'config.json', 'README.md', 'AUDIT.md', 'server.mjs', 'start-chrome-debug.bat', 'start-gemini.bat', 'start-gemini-app.bat', 'start-gemini-desktop.bat', 'start-bridge.bat', 'start-bridge-gemini.bat')
foreach ($folder in @('web', 'lib', 'backends', 'tools', 'test')) {
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
$extensionArchivePath = Join-Path $outputDir "gemini-web-bridge-extension-$version.zip"
$extensionStream = [System.IO.File]::Open($extensionArchivePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite)
$extensionZip = [System.IO.Compression.ZipArchive]::new($extensionStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in @('manifest.json', 'index.js', 'style.css', 'settings.html', 'INSTALL.md')) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($extensionZip, (Join-Path $projectRoot $file), ('gemini-web-bridge/' + $file), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $extensionZip.Dispose()
    $extensionStream.Dispose()
}
Write-Output $extensionArchivePath
