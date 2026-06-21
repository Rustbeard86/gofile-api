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

$ua = 'gofile-api-rs/0.1 (+https://github.com/Rustbeard86/gofile-api)'

function Invoke-Gofile {
    param([string] $Url)

    Write-Host "GET $Url" -ForegroundColor Cyan

    # -SkipHttpErrorCheck keeps the response (and body) even on 4xx/5xx so we can
    # actually read the API's error string instead of a bare exception.
    $resp = Invoke-WebRequest -Uri $Url -Headers $headers -Method Get `
        -UserAgent $ua -SkipHttpErrorCheck

    Write-Host ("Status : {0} {1}" -f [int]$resp.StatusCode, $resp.StatusCode) -ForegroundColor DarkGray
    Write-Host ("Length : {0} bytes" -f $resp.RawContentLength) -ForegroundColor DarkGray
    Write-Host ("Type   : {0}" -f $resp.Headers['Content-Type']) -ForegroundColor DarkGray

    $raw = $resp.Content
    Write-Host "--- raw ---" -ForegroundColor DarkGray
    if ([string]::IsNullOrEmpty($raw)) {
        Write-Host "(empty body)" -ForegroundColor Red
    }
    else {
        Write-Host $raw
    }

    Write-Host "--- formatted ---" -ForegroundColor DarkGray
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        try {
            $obj = $raw | ConvertFrom-Json
            $obj | ConvertTo-Json -Depth 20
            return $obj
        }
        catch {
            Write-Host "(body was not valid JSON: $($_.Exception.Message))" -ForegroundColor Red
        }
    }
    return $null
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
