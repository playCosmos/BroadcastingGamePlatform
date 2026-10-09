$ErrorActionPreference = "Stop"

$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = Get-ChildItem -Path $ServerRoot -Filter "*.ps1" -File

foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null

    if ($errors.Count -gt 0) {
        $details = $errors |
            ForEach-Object {
                "$($file.Name):$($_.Extent.StartLineNumber): $($_.Message)"
            }
        throw ("PowerShell syntax check failed: " + ($details -join " | "))
    }
}

Write-Host "[powershell] syntax check passed for $($files.Count) scripts"
