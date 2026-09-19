param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$CapMB = 900,
  [Parameter(Mandatory = $true)][string]$OutFile
)

# Scans a Kiro extension-host process for UUID v4 candidates (the mux token is a randomUUID).
#
# Read-only: OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ) + VirtualQueryEx + ReadProcessMemory.
# It never writes to, injects into, or suspends the target process.
#
# NOTE: the C# block below is intentionally ASCII-only. PowerShell 5.1 reads script files as ANSI when
# there is no BOM, which corrupts non-ASCII characters before they reach the C# compiler.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public class KiroUuidScan {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool b, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr s, out IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool VirtualQueryEx(IntPtr h, IntPtr a, out MBI m, IntPtr l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct MBI {
    public IntPtr BaseAddress, AllocationBase;
    public uint AllocationProtect;
    public IntPtr RegionSize;
    public uint State, Protect, Type;
  }

  static readonly Regex Rx = new Regex(
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}",
    RegexOptions.Compiled);

  static readonly Encoding L1 = Encoding.GetEncoding(28591);

  public static List<string> Run(int pid, int capMB, out long scannedOut, out string err) {
    long cap = (long)capMB * 1024L * 1024L;
    var set = new HashSet<string>();
    scannedOut = 0;
    err = "";

    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) {
      err = "OPEN_FAILED err=" + Marshal.GetLastWin32Error();
      return new List<string>();
    }

    byte[] buf = new byte[4 * 1024 * 1024];
    IntPtr addr = IntPtr.Zero;
    MBI mbi;
    string tail = "";
    long scanned = 0;
    int mbiSize = Marshal.SizeOf(typeof(MBI));

    while (true) {
      if (!VirtualQueryEx(h, addr, out mbi, (IntPtr)mbiSize)) break;
      long rs = (long)mbi.RegionSize;
      if (rs <= 0) break;

      bool readable = mbi.State == 0x1000
                   && (mbi.Protect & 0x100) == 0
                   && (mbi.Protect & 0xFF) != 0x01;

      if (readable && scanned < cap) {
        long off = 0;
        while (off < rs) {
          int want = (int)Math.Min((long)buf.Length, rs - off);
          IntPtr got;
          if (ReadProcessMemory(h, (IntPtr)((long)mbi.BaseAddress + off), buf, (IntPtr)want, out got)) {
            int n = (int)got;
            if (n > 0) {
              string t = tail + L1.GetString(buf, 0, n);
              foreach (Match m in Rx.Matches(t)) set.Add(m.Value.ToLowerInvariant());
              int keep = Math.Min(64, t.Length);
              tail = t.Substring(t.Length - keep);
              scanned += n;
            }
          } else {
            tail = "";
          }
          off += want;
        }
      }

      long next = (long)mbi.BaseAddress + rs;
      if (next <= (long)addr) break;
      addr = (IntPtr)next;
      if (scanned >= cap) break;
    }

    CloseHandle(h);
    scannedOut = scanned;
    return new List<string>(set);
  }
}
"@

$scanned = 0L
$err = ''
$uuids = [KiroUuidScan]::Run($TargetPid, $CapMB, [ref]$scanned, [ref]$err)
if ($err) { Write-Error $err; exit 1 }

[System.IO.File]::WriteAllLines($OutFile, $uuids, [System.Text.Encoding]::ASCII)
Write-Output ("pid={0} scannedMB={1} candidates={2}" -f $TargetPid, [int]($scanned / 1MB), $uuids.Count)
