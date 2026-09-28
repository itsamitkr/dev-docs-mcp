# Sets up a virtual environment (first run only) and starts the converter.
# Usage:  right-click > Run with PowerShell, or:  ./start-converter.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment (.venv)..."
    python -m venv .venv
}

Write-Host "Installing dependencies (first run can take a minute)..."
& .\.venv\Scripts\python.exe -m pip install --upgrade pip | Out-Null
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt

Write-Host "Starting converter on http://127.0.0.1:5000  (Ctrl+C to stop)"
& .\.venv\Scripts\python.exe app.py
