#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string] $InstallerPath,
    [Parameter(Mandatory=$true)][string] $InstallRoot,
    [Parameter(Mandatory=$true)][string] $PayloadEvidencePath,
    [Parameter(Mandatory=$true)][string] $OutputPath,
    [Parameter(Mandatory=$true)][string] $PostInstallExecutable,
    [Parameter(Mandatory=$true)][string[]] $PostInstallArguments,
    [ValidateSet('none','after-first-rule')][string] $TestFault = 'none'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'windows-installer-offline-watchdog.ps1') -FunctionsOnly
$proof = [ordered]@{schemaVersion=1; status='failed'; commit=$env:GITHUB_SHA; phase='input'; testFault=$TestFault; faultReached=$false; fixture=$null; installer=$null; callback=$null;
    runtimeBefore=$null; runtimeAfter=$null; policyBefore=$null; fence=$null; canary=$null; watchdog=$null; callbackProof=$null;
    windowStarted=$null; windowCompleted=$null; cleanupPassed=$false; error=$null}
$manifest = $null
$fixtureRoot = $null
$taskRegistered = $false
$guardProcess = $null
$child = $null
$canary = $null
$fileGuards = [Collections.Generic.List[IO.FileStream]]::new()
$windowClock = $null
$outputValidated = $false
$onlineAddress = $null
$fixtureSucceeded = $false
$cleanupError = $null

function Open-OfflineGuard([string] $Path) {
    Assert-OfflineNoReparse $Path
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    if ($stream.Length -le 0 -or $stream.Length -gt 1073741824) { $stream.Dispose(); throw 'A guarded file exceeds its bound.' }
    $fileGuards.Add($stream)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hashText=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant(); $stream.Position=0 }
    finally { $sha.Dispose() }
    return [ordered]@{path=$Path; bytes=$stream.Length; sha256=$hashText}
}
function Get-OfflineProfileState {
    foreach ($serviceName in @('BFE','MpsSvc')) { if ((Get-Service -Name $serviceName -ErrorAction Stop).Status -ne 'Running') { throw 'Required firewall service is not running.' } }
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop)
    if ($profiles.Count -ne 3) { throw 'Unexpected effective firewall profiles.' }
    $result=@()
    foreach ($item in $profiles) {
        if ("$($item.Enabled)" -cne 'True' -or "$($item.AllowLocalFirewallRules)" -ceq 'False') { throw 'Effective firewall enforcement is unavailable.' }
        $result += [ordered]@{name="$($item.Name)"; enabled="$($item.Enabled)"; localRules="$($item.AllowLocalFirewallRules)"; defaultOutbound="$($item.DefaultOutboundAction)"}
    }
    return $result
}
function Assert-OfflineNoBypass {
    $rules=@(Get-OfflineRules 'ActiveStore' | Where-Object { "$($_.Enabled)" -ceq 'True' -and "$($_.Action)" -ceq 'Allow' })
    if ($rules.Count -gt 0) {
        $filters=@($rules | Get-NetFirewallSecurityFilter -ErrorAction Stop)
        foreach ($filter in $filters) { if ("$($filter.OverrideBlockRules)" -ceq 'True') { throw 'Authenticated firewall bypass prevents an offline proof.' } }
    }
}
function Assert-OfflineAny($Value) {
    if (@($Value).Count -ne 1 -or "$(@($Value)[0])" -cne 'Any') { throw 'A firewall filter is narrower than the required all-traffic scope.' }
}
function Assert-OfflineFence {
    $rows=@(Get-OfflineRules 'ActiveStore' | Where-Object { $_.Name -cin @($manifest.outRule,$manifest.inRule) })
    if ($rows.Count -ne 2) { throw 'The effective offline fence is incomplete.' }
    $result=@()
    foreach ($rule in $rows) {
        $direction = if ($rule.Name -ceq $manifest.outRule) { 'Outbound' } else { 'Inbound' }
        if ("$($rule.Enabled)" -cne 'True' -or "$($rule.Action)" -cne 'Block' -or "$($rule.Direction)" -cne $direction -or
            "$($rule.Profile)" -cne 'Any' -or "$($rule.PrimaryStatus)" -cne 'OK' -or
            "$($rule.EnforcementStatus)" -cne 'Full') { throw 'The effective block rule is not fully enforced.' }
        $application=@($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
        $service=@($rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
        $port=@($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
        $address=@($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
        $interface=@($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
        $interfaceType=@($rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
        $security=@($rule | Get-NetFirewallSecurityFilter -ErrorAction Stop)
        foreach ($collection in @($application,$service,$port,$address,$interface,$interfaceType,$security)) { if ($collection.Count -ne 1) { throw 'Ambiguous effective firewall filters.' } }
        Assert-OfflineAny $application[0].Program
        Assert-OfflineAny $service[0].Service
        Assert-OfflineAny $port[0].Protocol
        Assert-OfflineAny $port[0].LocalPort
        Assert-OfflineAny $port[0].RemotePort
        Assert-OfflineAny $address[0].LocalAddress
        Assert-OfflineAny $address[0].RemoteAddress
        Assert-OfflineAny $interface[0].InterfaceAlias
        Assert-OfflineAny $interfaceType[0].InterfaceType
        if ("$($security[0].Authentication)" -cne 'NotRequired' -or "$($security[0].OverrideBlockRules)" -ceq 'True') { throw 'Unexpected firewall security condition.' }
        foreach ($scope in @($security[0].LocalUser,$security[0].RemoteUser,$security[0].RemoteMachine)) {
            if (-not [string]::IsNullOrEmpty("$scope") -and "$scope" -cne 'Any') { throw 'Unexpected firewall identity restriction.' }
        }
        $result += [ordered]@{name=$rule.Name; direction=$direction; action='Block'; profile='Any'; program='Any'; service='Any'; protocol='Any'; addresses='Any'; interfaces='Any'; primaryStatus="$($rule.PrimaryStatus)"; enforcementStatus="$($rule.EnforcementStatus)"}
    }
    return $result
}
function Assert-OfflineWindow {
    if ($null -eq $windowClock -or $windowClock.Elapsed.TotalSeconds -ge 235 -or $null -eq $guardProcess -or $guardProcess.HasExited -or
        [IO.File]::Exists([IO.Path]::Combine($fixtureRoot,'watchdog-final.json'))) { throw 'The independent offline window expired or ended.' }
}
function Read-OfflineRuntime {
    $subkey='SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $values=[ordered]@{machine=$null; user=$null; selected=$null; selectedScope=$null}
    foreach ($scope in @('machine','user')) {
        $hive=if($scope -ceq 'machine'){[Microsoft.Win32.RegistryHive]::LocalMachine}else{[Microsoft.Win32.RegistryHive]::CurrentUser}
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,[Microsoft.Win32.RegistryView]::Registry32)
        $key=$null
        try { $key=$base.OpenSubKey($subkey,$false); if($null -ne $key){$value=$key.GetValue('pv',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($null -ne $value -and $value -isnot [string]){throw 'Runtime pv is not a string.'};$values[$scope]=$value} }
        finally { if($null -ne $key){$key.Dispose()};$base.Dispose() }
    }
    if(-not [string]::IsNullOrEmpty($values.machine)){$values.selected=$values.machine;$values.selectedScope='machine'}
    elseif(-not [string]::IsNullOrEmpty($values.user)){$values.selected=$values.user;$values.selectedScope='user'}
    return $values
}
function Convert-OfflineVersion($Value) {
    if($Value -isnot [string] -or $Value -notmatch '^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}$'){throw 'A valid four-part runtime version is required.'}
    foreach($part in $Value.Split('.')){if([int]$part -gt 65535){throw 'Runtime version component is too large.'}}
    return [version]$Value
}
function Invoke-OfflineChild([string] $File,[string] $Arguments,[int] $Seconds,[string] $Name) {
    Assert-OfflineWindow
    Write-OfflineJson ([IO.Path]::Combine($fixtureRoot,"$Name-intent.json")) ([ordered]@{schemaVersion=1;fixtureId=$manifest.fixtureId;path=$File})
    $script:child=[MotionOfflineProcess]::new($File,$Arguments,(Split-Path $PSScriptRoot -Parent),($Name -ceq 'callback'))
    try {
        Write-OfflineJson ([IO.Path]::Combine($fixtureRoot,"$Name-process.json")) (Get-OfflineIdentity $child.Process)
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while(-not $child.Process.WaitForExit(100)){
            Assert-OfflineWindow
            if($clock.Elapsed.TotalSeconds -ge $Seconds -or $child.OutputExceeded){throw 'A bounded offline child exceeded its deadline or output limit.'}
        }
        Assert-OfflineWindow
        $capture=$child.Finish()
        if($capture.ExitCode -ne 0){throw "Offline $Name process returned nonzero."}
        return [ordered]@{exitCode=$capture.ExitCode; elapsedMilliseconds=$clock.ElapsedMilliseconds; stdout=$capture.Stdout; stderr=$capture.Stderr}
    } finally {
        if($null -ne $child){
            try {
                $child.Dispose()
                if($Name -ceq 'callback'){
                    $proof.callback.groupCleanupConfirmed=$child.GroupCleanupConfirmed
                    if(-not $child.GroupCleanupConfirmed){throw 'The callback process group did not become empty.'}
                }
            } finally {$script:child=$null}
        }
    }
}

try {
    Assert-OfflineHost
    Import-OfflineModules
    foreach($path in @($InstallerPath,$InstallRoot,$PayloadEvidencePath,$OutputPath,$PostInstallExecutable)){Assert-OfflineLocalPath $path}
    Assert-OfflineNoReparse ([IO.Path]::GetDirectoryName($OutputPath))
    if([IO.File]::Exists($OutputPath) -or [IO.Directory]::Exists($OutputPath)){throw 'Offline evidence must start absent.'}
    $outputValidated=$true
    Assert-OfflineNoReparse ([IO.Path]::GetDirectoryName($InstallRoot))
    if(Test-Path -LiteralPath $InstallRoot){throw 'The installation destination must start absent.'}
    $scriptPath=[IO.Path]::Combine($PSScriptRoot,'windows-installed-ui.mjs')
    if($PostInstallArguments.Count -ne 1 -or -not [string]::Equals($PostInstallArguments[0],$scriptPath,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetFileName($PostInstallExecutable),'node.exe',[StringComparison]::OrdinalIgnoreCase)){throw 'Only the fixed installed-UI Node callback is supported.'}
    $application=[IO.Path]::Combine($InstallRoot,'motion-desktop.exe')
    if($env:MOTION_ACCEPTANCE_PHASE -cne 'offline-prerequisite' -or
        -not [string]::Equals($env:MOTION_INSTALLED_APP,$application,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($env:MOTION_NATIVE_HELPER,$application,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($env:MOTION_ACCEPTANCE_OUTPUT,[IO.Path]::GetDirectoryName($OutputPath),[StringComparison]::OrdinalIgnoreCase)){throw 'The callback environment is not bound to this installation.'}
    $uiProofPath=[IO.Path]::Combine($env:MOTION_ACCEPTANCE_OUTPUT,'offline-prerequisite-ui.json')
    $activeProofPath=[IO.Path]::Combine($env:MOTION_ACCEPTANCE_OUTPUT,'offline-prerequisite-active-webview.json')
    foreach($path in @($uiProofPath,$activeProofPath)){if(Test-Path -LiteralPath $path){throw 'Callback evidence must start absent.'}}
    $proof.installer=Open-OfflineGuard $InstallerPath
    $payload=Read-OfflineJson $PayloadEvidencePath
    if($payload.schemaVersion -ne 1 -or $payload.status -cne 'passed' -or $payload.commit -cne $env:GITHUB_SHA -or
        $payload.installer.sha256 -cne $proof.installer.sha256){throw 'The exact installer lacks matching verified payload evidence.'}
    $proof.callback=[ordered]@{executable=(Open-OfflineGuard $PostInstallExecutable); script=(Open-OfflineGuard $scriptPath); completed=$false}
    $minimum=(Read-OfflineJson (Join-Path $PSScriptRoot 'windows-installer-payload-pin.json')).payload.containedRuntimeVersion
    $floor=Convert-OfflineVersion $minimum
    $proof.runtimeBefore=Read-OfflineRuntime
    if($null -eq $proof.runtimeBefore.selected -or (Convert-OfflineVersion $proof.runtimeBefore.selected) -ge $floor){throw 'The offline upgrade fixture requires an actually older, present runtime.'}
    $proof.phase='preflight'
    $proof.policyBefore=@(Get-OfflineProfileState)
    Assert-OfflineNoBypass

    # All compiler/runtime work occurs before network isolation. These helpers
    # use direct IP sockets (no cached DNS success inside the window), normal
    # TLS certificate validation, bounded headers and bounded child output.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Security.Authentication;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class MotionOfflineCanary : IDisposable {
  public const string Server = "www.microsoft.com";
  public readonly IPAddress Address;
  public int LastResponseBytes { get; private set; }
  private readonly TcpClient client;
  private readonly SslStream tls;
  public MotionOfflineCanary(IPAddress address) {
    Address=address; client=new TcpClient(address.AddressFamily);
    try {
      if(!client.ConnectAsync(address,443).Wait(5000)) throw new TimeoutException("Canary connect deadline");
      tls=new SslStream(client.GetStream(),false);
      if(!tls.AuthenticateAsClientAsync(Server,null,SslProtocols.Tls12,true).Wait(7000)) throw new TimeoutException("Canary TLS deadline");
    } catch { client.Close(); throw; }
  }
  public static IPAddress Resolve() {
    var task=Dns.GetHostAddressesAsync(Server);
    if(!task.Wait(5000)) throw new TimeoutException("Canary DNS deadline");
    foreach(var address in task.Result) if(address.AddressFamily==AddressFamily.InterNetwork && !IPAddress.IsLoopback(address)) return address;
    throw new IOException("No public IPv4 control address");
  }
  public int Request() {
    LastResponseBytes=0;
    var clock=Stopwatch.StartNew();
    var request=Encoding.ASCII.GetBytes("HEAD /?motion_offline="+Guid.NewGuid().ToString("N")+" HTTP/1.1\r\nHost: "+Server+"\r\nUser-Agent: Motion-Installer-Acceptance/1\r\nConnection: keep-alive\r\nCache-Control: no-cache\r\n\r\n");
    if(!tls.WriteAsync(request,0,request.Length).Wait(3000)) throw new TimeoutException("Canary send deadline");
    var header=new StringBuilder(); var octet=new byte[1];
    while(header.Length<16384) {
      var read=tls.ReadAsync(octet,0,1);
      var remaining=5000-(int)clock.ElapsedMilliseconds;
      if(remaining<=0 || !read.Wait(remaining)) throw new TimeoutException("Canary reply deadline");
      if(read.Result!=1) throw new IOException("Canary connection ended");
      LastResponseBytes++;
      header.Append((char)octet[0]);
      if(header.Length>=4 && header.ToString(header.Length-4,4)=="\r\n\r\n") {
        var text=header.ToString();
        if(!text.StartsWith("HTTP/1.1 ",StringComparison.Ordinal)) throw new InvalidDataException("Unexpected canary protocol");
        int code; if(!Int32.TryParse(text.Substring(9,3),out code) || code<200 || code>=400 || text.IndexOf("\r\nConnection: close",StringComparison.OrdinalIgnoreCase)>=0) throw new InvalidDataException("Canary is not reusable");
        return code;
      }
    }
    throw new InvalidDataException("Canary headers exceeded bound");
  }
  public string RetainedMustStop() {
    try { Request(); } catch(Exception error) { return ClassifyRetainedFailure(error,LastResponseBytes); }
    throw new InvalidOperationException("Existing external connection survived the fence");
  }
  public static string ClassifyRetainedFailure(Exception error,int receivedBytes) {
    if(receivedBytes!=0) throw new InvalidOperationException("External reply bytes arrived during the offline window",error);
    var aggregate=error as AggregateException;
    if(aggregate!=null) error=aggregate.InnerException;
    // InvalidDataException is an IOException, but describes a received response
    // or protocol violation, never evidence of firewall enforcement.
    if(error is InvalidDataException) throw new InvalidOperationException("Protocol failure cannot prove blocked traffic",error);
    if(error is TimeoutException) return "no-response-before-deadline";
    if(error is IOException || error is SocketException) return "connection-terminated-or-blocked";
    throw new InvalidOperationException("Unexpected retained connection failure",error);
  }
  public static void LoopbackControl() {
    var listener=new TcpListener(IPAddress.Loopback,0); TcpClient accepted=null;
    using(var client=new TcpClient(AddressFamily.InterNetwork)) {
      try {
        listener.Start(1); var incoming=listener.AcceptTcpClientAsync();
        if(!client.ConnectAsync(IPAddress.Loopback,((IPEndPoint)listener.LocalEndpoint).Port).Wait(2000) || !incoming.Wait(2000)) throw new TimeoutException("Local control connection deadline");
        accepted=incoming.Result;
        if(!accepted.Client.RemoteEndPoint.Equals(client.Client.LocalEndPoint)) throw new IOException("Local control peer changed");
        var value=new byte[]{77};
        if(!client.GetStream().WriteAsync(value,0,1).Wait(2000)) throw new TimeoutException("Local control send deadline");
        value[0]=0; var read=accepted.GetStream().ReadAsync(value,0,1);
        if(!read.Wait(2000) || read.Result!=1 || value[0]!=77) throw new IOException("Local control traffic failed");
      } finally {if(accepted!=null) accepted.Close();listener.Stop();}
    }
  }
  public static string NewMustStop(IPAddress address) {
    using(var socket=new TcpClient(address.AddressFamily)) {
      try { if(!socket.ConnectAsync(address,443).Wait(3000)) return "connect-deadline"; }
      catch(AggregateException e) { var s=e.InnerException as SocketException; if(s!=null && (s.SocketErrorCode==SocketError.AccessDenied || s.SocketErrorCode==SocketError.TimedOut)) return s.SocketErrorCode.ToString(); throw; }
      throw new InvalidOperationException("A new external connection survived the fence");
    }
  }
  public void Dispose() { if(tls!=null) tls.Dispose(); client.Close(); }
}
public sealed class MotionOfflineCapture { public int ExitCode; public string Stdout; public string Stderr; }
// Documented jobapi2/process APIs and SDK layouts, cross-checked against the
// already locked windows-sys 0.61.2 generated JobObjects/Threading declarations.
// CreateJobObjectW(NULL,NULL) returns an unnamed, non-inheritable handle.
// learn.microsoft.com/windows/win32/procthread/job-objects
public sealed class MotionOfflineJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
    public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinimumWorkingSet,MaximumWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
    public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Accounting {
    public long UserTime,KernelTime,PeriodUserTime,PeriodKernelTime; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetInformationJobObject(SafeFileHandle job,int informationClass,ref ExtendedLimits info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool QueryInformationJobObject(SafeFileHandle job,int informationClass,out Accounting info,uint length,IntPtr returnedLength);
  [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateJobObject(SafeFileHandle job,uint exitCode);
  private SafeFileHandle handle;
  public bool CleanupConfirmed {get;private set;}
  public static bool LayoutsCorrect() {return IntPtr.Size==8 && Marshal.SizeOf(typeof(ExtendedLimits))==144 && Marshal.SizeOf(typeof(Accounting))==48;}
  public MotionOfflineJob() {
    if(!LayoutsCorrect()) throw new PlatformNotSupportedException("The callback job requires the verified Windows x64 layouts");
    handle=CreateJobObjectW(IntPtr.Zero,null);
    if(handle.IsInvalid) {var error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);}
    var limits=new ExtendedLimits();limits.Basic.Flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway flags.
    if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
      var error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);
    }
  }
  public void Assign(Process process) {
    if(!AssignProcessToJobObject(handle,process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public void Dispose() {
    if(handle==null || handle.IsClosed) return;
    try {
      if(!TerminateJobObject(handle,1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var clock=Stopwatch.StartNew();
      while(true) {
        Accounting info;
        if(!QueryInformationJobObject(handle,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(info.ActiveProcesses==0){CleanupConfirmed=true;break;}
        if(clock.ElapsedMilliseconds>=5000) throw new IOException("Callback job did not become empty");
        Thread.Sleep(25);
      }
    } finally {handle.Dispose();}
  }
}
public sealed class MotionOfflineProcess : IDisposable {
  public readonly Process Process;
  private readonly Task<string> stdout;
  private readonly Task<string> stderr;
  private int bytes;
  private MotionOfflineJob job;
  private bool disposed;
  public bool GroupCleanupConfirmed {get;private set;}
  public bool OutputExceeded { get; private set; }
  public MotionOfflineProcess(string file,string arguments,string directory):this(file,arguments,directory,false){}
  public MotionOfflineProcess(string file,string arguments,string directory,bool gatedCallback) {
    Process=new Process(); Process.StartInfo=new ProcessStartInfo(file,arguments) { UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=directory,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true };
    bool started=false;
    try {
      if(gatedCallback) job=new MotionOfflineJob();
      if(!Process.Start()) throw new IOException("Child did not start");
      started=true;stdout=Read(Process.StandardOutput);stderr=Read(Process.StandardError);
      if(gatedCallback) {
        // The fixed bootstrap cannot import the UI controller until this
        // assignment succeeds. Parent death before assignment closes stdin;
        // EOF without the exact token exits the waiting bootstrap.
        job.Assign(Process);
        Process.StandardInput.Write("MOTION_OFFLINE_CALLBACK_START\n");Process.StandardInput.Flush();
      }
      Process.StandardInput.Close();
    } catch {
      try {if(started && !Process.HasExited){Process.Kill();Process.WaitForExit(5000);}}
      finally {try{if(job!=null)job.Dispose();}finally{Process.Dispose();}}
      throw;
    }
  }
  private async Task<string> Read(StreamReader stream) {
    var result=new StringBuilder(); var chunk=new char[1024]; int count;
    while((count=await stream.ReadAsync(chunk,0,chunk.Length).ConfigureAwait(false))!=0) {
      if(Interlocked.Add(ref bytes,Encoding.UTF8.GetByteCount(chunk,0,count))>65536) { OutputExceeded=true; try{Process.Kill();}catch(InvalidOperationException){} throw new IOException("Child output limit"); }
      result.Append(chunk,0,count);
    }
    return result.ToString();
  }
  public MotionOfflineCapture Finish() {
    if(!Task.WaitAll(new Task[]{stdout,stderr},3000) || OutputExceeded) throw new IOException("Child output did not close");
    return new MotionOfflineCapture {ExitCode=Process.ExitCode,Stdout=stdout.Result,Stderr=stderr.Result};
  }
  public void Dispose() {
    if(disposed)return;disposed=true;
    try {
      if(job!=null){job.Dispose();GroupCleanupConfirmed=job.CleanupConfirmed;}
      else if(!Process.HasExited){Process.Kill(); if(!Process.WaitForExit(5000)) throw new IOException("Owned child termination failed");}
    } finally { Process.Dispose(); }
  }
}
'@ -ErrorAction Stop
    $onlineAddress=[MotionOfflineCanary]::Resolve()
    $canary=[MotionOfflineCanary]::new($onlineAddress)
    $first=$canary.Request(); $second=$canary.Request()
    $proof.canary=[ordered]@{host=[MotionOfflineCanary]::Server; address=$onlineAddress.ToString(); family='IPv4'; before=@($first,$second); retainedDuring=$null; retainedResponseBytes=$null; newDuring=$null; loopbackDuring=$false; after=$null; ipv6Probe='not-observed'; scope='Effective rules cover all IP protocols and families; this network control uses the reachable IPv4 route.'}

    $proof.phase='watchdog'
    Assert-OfflineNoReparse $env:RUNNER_TEMP
    $fixtureId=[Guid]::NewGuid().ToString('N'); $name="MotionInstallerOffline-$fixtureId"
    $fixtureRoot=[IO.Path]::Combine($env:RUNNER_TEMP,$name)
    if(Test-Path -LiteralPath $fixtureRoot){throw 'Fixture path collision.'}
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    foreach($ownerSid in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerSid,[Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    [void][IO.Directory]::CreateDirectory($fixtureRoot,$acl)
    # Only built-in Node modules run before the exact stdin token is received
    # and EOF observed. No imported UI/controller code can spawn a child before
    # the callback process has joined its non-inheritable kill-on-close Job.
    $bootstrapSource=@'
import { pathToFileURL } from 'node:url';
if (process.argv.length !== 3) throw new Error('Invalid offline callback arguments');
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 64) throw new Error('Offline callback gate exceeded its bound');
  chunks.push(chunk);
}
if (Buffer.concat(chunks).toString('utf8') !== 'MOTION_OFFLINE_CALLBACK_START\n') {
  throw new Error('Offline callback was not assigned and released');
}
await import(pathToFileURL(process.argv[2]).href);
'@
    $bootstrapPath=[IO.Path]::Combine($fixtureRoot,'callback-bootstrap.mjs')
    $bootstrapBytes=[Text.UTF8Encoding]::new($false).GetBytes($bootstrapSource)
    $bootstrapFile=[IO.File]::Open($bootstrapPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$bootstrapFile.Write($bootstrapBytes,0,$bootstrapBytes.Length);$bootstrapFile.Flush($true)}finally{$bootstrapFile.Dispose()}
    $proof.callback.bootstrap=Open-OfflineGuard $bootstrapPath
    $proof.callback.groupCleanupConfirmed=$false
    $watchdogPath=Join-Path $PSScriptRoot 'windows-installer-offline-watchdog.ps1'
    $watchdogFile=Open-OfflineGuard $watchdogPath
    $manifest=[pscustomobject]@{schemaVersion=1; fixtureId=$fixtureId; commit=$env:GITHUB_SHA; runId=$env:GITHUB_RUN_ID; root=$fixtureRoot;
        taskName=$name; outRule="$name-Out"; inRule="$name-In"; selfTestRule="$name-SelfTest"; coordinator=(Get-OfflineIdentity ([Diagnostics.Process]::GetCurrentProcess()));
        installerPath=$InstallerPath; callbackPath=$PostInstallExecutable; watchdogSha256=$watchdogFile.sha256; maxSeconds=240}
    $manifestPath=[IO.Path]::Combine($fixtureRoot,'manifest.json')
    Write-OfflineJson $manifestPath $manifest
    $proof.fixture=[ordered]@{id=$fixtureId; manifest=$manifestPath; task=$name; rules=@($manifest.outRule,$manifest.inRule)}
    if(-not $env:GITHUB_OUTPUT){throw 'The final-cleanup output channel is missing.'}
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "offline_fixture_manifest=$manifestPath" -Encoding utf8
    New-NetFirewallRule -Name $manifest.selfTestRule -DisplayName $manifest.selfTestRule -Direction Outbound -Action Block -Enabled False -Profile Any -PolicyStore PersistentStore -ErrorAction Stop | Out-Null
    $systemShell=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\powershell.exe')
    $action=New-ScheduledTaskAction -Execute $systemShell -Argument "-NoLogo -NoProfile -NonInteractive -File `"$watchdogPath`" -ManifestPath `"$manifestPath`""
    $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromSeconds(300)) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskPath '\' -TaskName $name -Action $action -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
    $taskRegistered=$true
    Start-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction Stop
    $readyPath=[IO.Path]::Combine($fixtureRoot,'ready.json')
    $readyClock=[Diagnostics.Stopwatch]::StartNew()
    while(-not [IO.File]::Exists($readyPath)){
        if($readyClock.Elapsed.TotalSeconds -ge 25 -or [IO.File]::Exists([IO.Path]::Combine($fixtureRoot,'watchdog-final.json'))){throw 'The independent watchdog did not become ready.'}
        Start-Sleep -Milliseconds 100
    }
    $ready=Read-OfflineJson $readyPath
    if($ready.schemaVersion -ne 1 -or $ready.fixtureId -cne $fixtureId -or $ready.systemSid -cne 'S-1-5-18' -or $ready.selfTestRemoved -ne $true -or $ready.maxSeconds -ne 240){throw 'Invalid watchdog readiness proof.'}
    $guardProcess=[Diagnostics.Process]::GetProcessById([int]$ready.process.processId)
    Assert-OfflineIdentity (Get-OfflineIdentity $guardProcess) $ready.process
    if((Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction Stop).State -ne 'Running'){throw 'The recovery task is not running.'}

    $proof.phase='fence'
    $windowClock=[Diagnostics.Stopwatch]::StartNew()
    $proof.windowStarted=[DateTime]::UtcNow.ToString('o')
    New-NetFirewallRule -Name $manifest.outRule -DisplayName $manifest.outRule -Direction Outbound -Action Block -Profile Any -Enabled True -PolicyStore PersistentStore -ErrorAction Stop | Out-Null
    if($TestFault -ceq 'after-first-rule'){$proof.faultReached=$true;throw 'Requested deterministic fence-creation failure.'}
    New-NetFirewallRule -Name $manifest.inRule -DisplayName $manifest.inRule -Direction Inbound -Action Block -Profile Any -Enabled True -PolicyStore PersistentStore -ErrorAction Stop | Out-Null
    $proof.fence=@(Assert-OfflineFence)
    [void](Get-OfflineProfileState); Assert-OfflineNoBypass
    $proof.canary.retainedDuring=$canary.RetainedMustStop()
    $proof.canary.retainedResponseBytes=$canary.LastResponseBytes
    $proof.canary.newDuring=[MotionOfflineCanary]::NewMustStop($onlineAddress)
    [MotionOfflineCanary]::LoopbackControl()
    $proof.canary.loopbackDuring=$true
    $canary.Dispose();$canary=$null
    Assert-OfflineWindow
    $proof.phase='installer'
    $installation=Invoke-OfflineChild $InstallerPath "/S /D=$InstallRoot" 180 'installer'
    $proof.installer.exitCode=$installation.exitCode; $proof.installer.elapsedMilliseconds=$installation.elapsedMilliseconds
    $proof.runtimeAfter=Read-OfflineRuntime
    if($null -eq $proof.runtimeAfter.selected -or (Convert-OfflineVersion $proof.runtimeAfter.selected) -lt $floor){throw 'The installed registration did not meet the runtime floor while offline.'}
    $proof.phase='callback'
    $callback=Invoke-OfflineChild $PostInstallExecutable ('"'+$bootstrapPath+'" "'+$scriptPath+'"') 60 'callback'
    $proof.callback.completed=$true; $proof.callback.exitCode=$callback.exitCode; $proof.callback.elapsedMilliseconds=$callback.elapsedMilliseconds
    Assert-OfflineWindow
    $ui=Read-OfflineJson $uiProofPath
    $active=Read-OfflineJson $activeProofPath
    if($ui.schemaVersion -ne 1 -or $ui.commit -cne $env:GITHUB_SHA -or $ui.phase -cne 'offline-prerequisite' -or $ui.verdict -cne 'PASS' -or
        @($ui.activeWebView).Count -ne 1 -or $ui.activeWebView[0].status -cne 'passed' -or
        $active.schemaVersion -ne 1 -or $active.commit -cne $env:GITHUB_SHA -or $active.phase -cne 'offline-prerequisite' -or
        $active.minimumVersion -cne $minimum -or @($active.observations).Count -ne 1 -or $active.observations[0].status -cne 'passed' -or
        (ConvertTo-Json -InputObject $ui.activeWebView[0] -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $active.observations[0] -Depth 12 -Compress)){
        throw 'The callback did not preserve one matching active-engine observation.'
    }
    $native=$active.observations[0].native
    if($native.ok -ne $true -or $native.phase -cne 'complete' -or $native.rechecked -ne $true -or $native.minimumVersion -cne $minimum -or
        (Convert-OfflineVersion $native.executable.fileVersion) -lt $floor){throw 'The callback did not establish the actual running engine while fenced.'}
    $proof.callbackProof=[ordered]@{uiSha256=(Get-OfflineHash $uiProofPath); activeSha256=(Get-OfflineHash $activeProofPath); runtime=$native.executable.fileVersion; path=$native.executable.path; observedBeforeFenceRemoval=$true}
    $proof.fence=@(Assert-OfflineFence)
    [void](Get-OfflineProfileState); Assert-OfflineNoBypass
    Assert-OfflineWindow
    $proof.windowCompleted=[DateTime]::UtcNow.ToString('o')
    $fixtureSucceeded=$true
} catch {
    $proof.error=[ordered]@{type=$_.Exception.GetType().FullName; hresult=('{0:X8}' -f $_.Exception.HResult); message=$_.Exception.Message.Substring(0,[Math]::Min(500,$_.Exception.Message.Length))}
} finally {
    if($null -ne $canary){$canary.Dispose()}
    if($null -ne $manifest){
        try {
            $stopPath=[IO.Path]::Combine($fixtureRoot,'stop.json')
            if(-not [IO.File]::Exists($stopPath)){Write-OfflineJson $stopPath ([ordered]@{fixtureId=$manifest.fixtureId;reason=$(if($fixtureSucceeded){'complete'}else{'failed'})})}
            # Do not stop the independent guard before its recovery completes.
            $finalPath=[IO.Path]::Combine($fixtureRoot,'watchdog-final.json')
            $cleanupClock=[Diagnostics.Stopwatch]::StartNew()
            while($taskRegistered -and -not [IO.File]::Exists($finalPath) -and $cleanupClock.Elapsed.TotalSeconds -lt 30){Start-Sleep -Milliseconds 100}
            Remove-OfflineRules $manifest
            if([IO.File]::Exists($finalPath)){
                $proof.watchdog=Read-OfflineJson $finalPath
                if($proof.watchdog.cleanupPassed -ne $true -or ($fixtureSucceeded -and $proof.watchdog.status -cne 'passed')){throw 'The independent watchdog reported failure.'}
            }elseif($taskRegistered){throw 'Independent watchdog cleanup was not confirmed.'}
            if($taskRegistered){Remove-OfflineTask $manifest}
            [void](Get-OfflineProfileState)
            $proof.cleanupPassed=$true
        } catch { $cleanupError=[ordered]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message};$proof.cleanupPassed=$false }
    }
    if($null -ne $guardProcess){$guardProcess.Dispose()}
    if($proof.cleanupPassed -and $null -ne $onlineAddress){
        try{$restored=[MotionOfflineCanary]::new($onlineAddress);try{$proof.canary.after=$restored.Request()}finally{$restored.Dispose()}}
        catch{$proof.cleanupPassed=$false;$cleanupError=[ordered]@{type=$_.Exception.GetType().FullName;message='The public canary did not recover after cleanup.'}}
    }
    foreach($stream in $fileGuards){$stream.Dispose()}
    if($fixtureSucceeded -and $proof.cleanupPassed){$proof.status='passed';$proof.phase='complete'}
    if($null -ne $cleanupError){$proof.error=$cleanupError}
    if($outputValidated){Write-OfflineJson $OutputPath $proof}
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{schemaVersion=1;status=$proof.status;phase=$proof.phase;cleanupPassed=$proof.cleanupPassed;fixture=$proof.fixture;error=$proof.error}) -Depth 5 -Compress))
if($proof.status -cne 'passed'){exit 1}
