<#
.SYNOPSIS
    Dumps the raw Gofile account responses so the JSON shape can be confirmed.

.DESCRIPTION
    Calls /accounts/getid (unless you pass -AccountId) and then
    /accounts/{accountId}, printing the raw JSON for each. The point is to see
    the exact field names the API returns (e.g. the rootFolder key) so the Rust
    types can match.

.PARAMETER Token
    Your API token from https://gofile.io/myprofile. Required.

.PARAMETER AccountId
    Optional. If omitted, it's looked up from the token via /accounts/getid.

.EXAMPLE
    ./scripts/Get-GofileAccount.ps1 -Token "xxxxxxxx"

.EXAMPLE
    ./scripts/Get-GofileAccount.ps1 -Token "xxxxxxxx" -AccountId "1234-abcd"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Token,

    [Parameter(Mandatory = $false)]
    [string] $AccountId
)

$ErrorActionPreference = 'Stop'

$headers = @{ Authorization = "Bearer $Token" }

function Invoke-Gofile {
    param([string] $Url)

    Write-Host "GET $Url" -ForegroundColor Cyan
    try {
        $resp = Invoke-WebRequest -Uri $Url -Headers $headers -Method Get
        # Re-emit the raw body, then pretty-print it for readability.
        $raw = $resp.Content
        Write-Host "--- raw ---" -ForegroundColor DarkGray
        Write-Output $raw
        Write-Host "--- formatted ---" -ForegroundColor DarkGray
        $raw | ConvertFrom-Json | ConvertTo-Json -Depth 20
        return ($raw | ConvertFrom-Json)
    }
    catch {
        Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            $stream = $_.Exception.Response.GetResponseStream()
            $body = (New-Object System.IO.StreamReader($stream)).ReadToEnd()
            Write-Host "Body: $body" -ForegroundColor Red
        }
        throw
    }
}

if ([string]::IsNullOrWhiteSpace($AccountId)) {
    Write-Host "No -AccountId supplied; resolving it from the token..." -ForegroundColor Yellow
    $idResp = Invoke-Gofile -Url "https://api.gofile.io/accounts/getid"
    $AccountId = $idResp.data.id
    if ([string]::IsNullOrWhiteSpace($AccountId)) {
        throw "Could not read data.id from /accounts/getid response."
    }
    Write-Host "Resolved AccountId: $AccountId" -ForegroundColor Green
    Write-Host ""
}

Write-Host "Fetching account details..." -ForegroundColor Yellow
Invoke-Gofile -Url "https://api.gofile.io/accounts/$AccountId" | Out-Null

Write-Host ""
Write-Host "Copy the '--- formatted ---' block from the account details call back to me." -ForegroundColor Green
