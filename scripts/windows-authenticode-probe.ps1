param([Parameter(Mandatory = $true)][string] $LiteralPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($env:OS -ne 'Windows_NT' -or $LiteralPath -notmatch '^[A-Za-z]:[\\/]') {
    throw 'Authenticode inspection requires an absolute local Windows file.'
}
$file = Get-Item -LiteralPath $LiteralPath -Force
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Authenticode inspection requires a regular file.'
}

function Get-CertificateRecord($Certificate) {
    if ($null -eq $Certificate) { return $null }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = [BitConverter]::ToString($algorithm.ComputeHash($Certificate.GetRawCertData())).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
    return [ordered]@{
        subject = $Certificate.Subject
        issuer = $Certificate.Issuer
        derSha256 = $digest
        notBeforeUtc = $Certificate.NotBefore.ToUniversalTime().ToString('o')
        notAfterUtc = $Certificate.NotAfter.ToUniversalTime().ToString('o')
    }
}

# Inspect the PE signature through the Windows trust provider. This never runs
# the inspected executable. SignTool's separate embedded-signature verification
# remains mandatory; a catalog signature cannot replace that check.
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file.FullName)
[ordered]@{
    schemaVersion = 1
    status = $signature.Status.ToString()
    signatureType = $signature.SignatureType.ToString()
    signer = Get-CertificateRecord $signature.SignerCertificate
    timestampSigner = Get-CertificateRecord $signature.TimeStamperCertificate
    fileVersion = "$($version.FileMajorPart).$($version.FileMinorPart).$($version.FileBuildPart).$($version.FilePrivatePart)"
    originalFilename = $version.OriginalFilename
} | ConvertTo-Json -Depth 6 -Compress
