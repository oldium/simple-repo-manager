# native-windows-close.ps1 -CommandLine <command> -ReadyUrl <url> -Log <file>: runs the command on a console of its own,
# as a terminal tab does, and closes that console once the URL answers, as closing the tab or the window does.
# Prints "exited <ms>", or "still running" or "not ready" with a non-zero exit code.
param(
    [Parameter(Mandatory)] [string] $CommandLine,
    [Parameter(Mandatory)] [string] $ReadyUrl,
    [Parameter(Mandatory)] [string] $Log,
    [int] $ReadySeconds = 60,
    [int] $ExitSeconds = 20
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class PseudoConsole {
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit,
        uint flags, IntPtr environment, string directory, ref StartupInfoEx startupInfo, out ProcessInformation information);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    static IntPtr console;
    static IntPtr process;
    static SafeFileHandle input;

    public static int Start(string commandLine, string log) {
        SafeFileHandle inputRead, outputRead, outputWrite;
        if (!CreatePipe(out inputRead, out input, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0)) {
            throw new Exception("CreatePipe failed: " + Marshal.GetLastWin32Error());
        }
        int result = CreatePseudoConsole(new Coord { X = 200, Y = 50 }, inputRead, outputWrite, 0, out console);
        if (result != 0) {
            throw new Exception("CreatePseudoConsole failed: " + result);
        }
        inputRead.Dispose();
        outputWrite.Dispose();
        // The console stops when nobody reads what it writes
        Thread reader = new Thread(() => {
            using (FileStream from = new FileStream(outputRead, FileAccess.Read))
            using (FileStream to = new FileStream(log, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) {
                byte[] buffer = new byte[4096];
                int n;
                try { while ((n = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, n); to.Flush(); } } catch (IOException) { }
            }
        });
        reader.IsBackground = true;
        reader.Start();

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        StartupInfoEx startup = new StartupInfoEx();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        // Empty handles, so the process writes to its console rather than to where this script's output goes
        startup.StartupInfo.dwFlags = 0x00000100;
        startup.lpAttributeList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref size)
            || !UpdateProcThreadAttribute(startup.lpAttributeList, 0, (IntPtr)0x00020016, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) {
            throw new Exception("Attribute list failed: " + Marshal.GetLastWin32Error());
        }
        ProcessInformation information;
        if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, null, ref startup, out information)) {
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
        }
        process = information.hProcess;
        return information.dwProcessId;
    }

    /** Milliseconds until the process ends after the close, -1 when it does not */
    public static long Close(int exitSeconds) {
        DateTime started = DateTime.UtcNow;
        new Thread(() => ClosePseudoConsole(console)) { IsBackground = true }.Start();
        if (WaitForSingleObject(process, (uint)(exitSeconds * 1000)) != 0) {
            return -1;
        }
        return (long)(DateTime.UtcNow - started).TotalMilliseconds;
    }
}
"@

$processId = [PseudoConsole]::Start($CommandLine, $Log)
$deadline = (Get-Date).AddSeconds($ReadySeconds)
$ready = $false
while (-not $ready -and (Get-Date) -lt $deadline) {
    try {
        $ready = (Invoke-WebRequest -Uri $ReadyUrl -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
    } catch {
        Start-Sleep -Milliseconds 300
    }
}
if (-not $ready) {
    Write-Output "not ready"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    exit 2
}
$elapsed = [PseudoConsole]::Close($ExitSeconds)
if ($elapsed -lt 0) {
    Write-Output "still running"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Output "exited $elapsed"
