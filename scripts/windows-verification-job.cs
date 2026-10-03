// Standalone test-runner infrastructure. Windows 10 / Server 2016 or newer.
// Job membership is atomic at CreateProcessW (PROC_THREAD_ATTRIBUTE_JOB_LIST),
// so a supervisor crash cannot strand a child between creation and assignment.
// This cooperative cleanup facility is not a hostile-code security sandbox.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Fate {
public static class VerificationJob {
    const uint KILL_ON_JOB_CLOSE = 0x2000, CREATE_SUSPENDED = 0x4;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint STARTF_USESTDHANDLES = 0x100, DUPLICATE_SAME_ACCESS = 2;
    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, STOP_EXIT_CODE = 0xF001;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting info, uint size, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfoEx startupInfo, out ProcessInfo processInfo);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess,
        IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static string Encoded(string message) {
        return String.IsNullOrEmpty(message) ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(message));
    }
    public static string ReadBoundedLine(StreamReader reader, int maximum) {
        StringBuilder line = new StringBuilder();
        while (true) {
            int value = reader.Read();
            if (value < 0) return line.Length == 0 ? null : line.ToString();
            if (value == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= maximum) throw new IOException("Oversized verification control frame.");
            line.Append((char)value);
        }
    }
    // Microsoft C-runtime argv rules. No command shell ever interprets this text.
    public static string Quote(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid argument.");
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', 2 * slashes + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', 2 * slashes); result.Append('"'); return result.ToString();
    }
    static uint ActiveProcesses(IntPtr job) {
        Accounting info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
        return info.ActiveProcesses;
    }
    static void Close(ref IntPtr handle) {
        if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE) {
            IntPtr owned = handle; handle = IntPtr.Zero; Check(CloseHandle(owned), "CloseHandle");
        }
    }
    public static void Run(StreamReader control, StreamWriter receipts, string executable, string[] args,
        string cwd, string[] envKeys, string[] envValues, int descendantGraceMs, int settlementTimeoutMs) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobList = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr[] standard = new IntPtr[3];
        ProcessInfo child = new ProcessInfo();
        bool attributesInitialized = false, created = false, resumed = false, settled = false, stopRequested = false;
        uint? exitCode = null;
        string failure = null;
        int cancelled = 0;
        try {
            if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd) || executable.IndexOf('\0') >= 0 || cwd.IndexOf('\0') >= 0)
                throw new ArgumentException("Expected absolute executable and working directory.");
            if (descendantGraceMs < 0 || descendantGraceMs > 30000 || settlementTimeoutMs < 1 || settlementTimeoutMs > 30000)
                throw new ArgumentException("Invalid settlement deadline.");
            StringBuilder command = new StringBuilder(Quote(executable));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            if (command.Length >= 32767) throw new ArgumentException("Windows command line exceeds 32766 UTF-16 characters.");
            if (envKeys.Length != envValues.Length) throw new ArgumentException("Invalid environment.");
            Array.Sort(envKeys, envValues, StringComparer.OrdinalIgnoreCase);
            StringBuilder block = new StringBuilder();
            for (int i = 0; i < envKeys.Length; i++) {
                if (String.IsNullOrEmpty(envKeys[i]) || envKeys[i].IndexOfAny(new char[] { '=', '\0' }) >= 0 || envValues[i].IndexOf('\0') >= 0 ||
                    i > 0 && String.Equals(envKeys[i], envKeys[i - 1], StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid or duplicate environment key.");
                block.Append(envKeys[i]).Append('=').Append(envValues[i]).Append('\0');
            }
            block.Append('\0'); if (envKeys.Length == 0) block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObjectW");
            ExtendedLimits limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Attribute-list size");
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList");
            attributesInitialized = true;
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            for (int i = 0; i < 3; i++) {
                IntPtr source = GetStdHandle(-10 - i);
                Check(source != IntPtr.Zero && source != INVALID_HANDLE_VALUE, "GetStdHandle");
                Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out standard[i], 0, true, DUPLICATE_SAME_ACCESS), "DuplicateHandle");
                Marshal.WriteIntPtr(handles, i * IntPtr.Size, standard[i]);
            }
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new UIntPtr((uint)(3 * IntPtr.Size)), IntPtr.Zero, IntPtr.Zero), "Standard-handle allowlist");
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            // Windows 10+ atomically associates this newly created child with our
            // private job. Never fall back to an uncontained launch or breakaway.
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Atomic job-list attribute");
            StartupInfoEx startup = new StartupInfoEx();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = standard[0]; startup.StartupInfo.hStdOutput = standard[1]; startup.StartupInfo.hStdError = standard[2];
            startup.lpAttributeList = attributes;
            // No payload instructions execute before its owner installs output
            // listeners and explicitly acknowledges this suspended-child receipt.
            Task<string> admission = Task.Run(() => ReadBoundedLine(control, 32));
            if (admission.IsCompleted) {
                receipts.WriteLine("not-started " + Encoded("Owner cancelled before launch.")); return;
            }
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                environment, cwd, ref startup, out child), "CreateProcessW with atomic job membership");
            created = true;
            for (int i = 0; i < 3; i++) Close(ref standard[i]);
            receipts.WriteLine("started " + child.dwProcessId);
            if (!admission.Wait(settlementTimeoutMs)) throw new IOException("Owner did not acknowledge the suspended verification child.");
            if (admission.Result != "resume") throw new OperationCanceledException("Owner cancelled the suspended verification child.");
            // EOF means the owner disappeared. It is cancellation, never success.
            Task.Run(() => {
                try { ReadBoundedLine(control, 32); }
                catch { }
                Interlocked.Exchange(ref cancelled, 1);
            });
            if (Volatile.Read(ref cancelled) != 0) throw new OperationCanceledException("Owner cancelled before resume.");
            Check(ResumeThread(child.hThread) != UInt32.MaxValue, "ResumeThread"); resumed = true;
            Close(ref child.hThread);
            Stopwatch rootExited = null, stopping = null;
            while (true) {
                if (child.hProcess != IntPtr.Zero) {
                    uint waited = WaitForSingleObject(child.hProcess, 0);
                    if (waited == WAIT_OBJECT_0) {
                        uint code; Check(GetExitCodeProcess(child.hProcess, out code), "GetExitCodeProcess"); exitCode = code;
                        // Release the process reference before requiring job accounting zero.
                        Close(ref child.hProcess); rootExited = Stopwatch.StartNew();
                    } else if (waited != WAIT_TIMEOUT) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
                }
                if (exitCode.HasValue && ActiveProcesses(job) == 0) { settled = true; break; }
                bool outlived = rootExited != null && rootExited.ElapsedMilliseconds >= descendantGraceMs;
                if (!stopRequested && (Volatile.Read(ref cancelled) != 0 || outlived)) {
                    if (outlived && Volatile.Read(ref cancelled) == 0) failure = "A descendant outlived the verification root.";
                    Check(TerminateJobObject(job, STOP_EXIT_CODE), "TerminateJobObject");
                    stopRequested = true; stopping = Stopwatch.StartNew();
                }
                if (stopping != null && stopping.ElapsedMilliseconds >= settlementTimeoutMs) {
                    failure = "Owned Windows job did not reach observed zero active processes."; break;
                }
                Thread.Sleep(10);
            }
        } catch (Exception error) {
            failure = error.Message;
            // Even failures before ResumeThread retain a job handle covering the
            // atomic child. No PID lookup, name lookup, or broad tree kill occurs.
            if (created && job != IntPtr.Zero) {
                try {
                    Check(TerminateJobObject(job, STOP_EXIT_CODE), "TerminateJobObject after failure");
                    if (child.hProcess != IntPtr.Zero && WaitForSingleObject(child.hProcess, (uint)settlementTimeoutMs) == WAIT_OBJECT_0) {
                        uint code; if (GetExitCodeProcess(child.hProcess, out code)) exitCode = code;
                        Close(ref child.hProcess);
                    }
                    Close(ref child.hThread);
                    Stopwatch deadline = Stopwatch.StartNew();
                    while (ActiveProcesses(job) != 0 && deadline.ElapsedMilliseconds < settlementTimeoutMs) Thread.Sleep(10);
                    settled = ActiveProcesses(job) == 0;
                } catch { settled = false; }
            }
        } finally {
            // Never call this settled merely because closing the last handle asks
            // Windows to kill members: only the observed accounting zero above proves it.
            try { Close(ref child.hThread); Close(ref child.hProcess); }
            catch { settled = false; failure = "Owned process handle cleanup failed."; }
            for (int i = 0; i < standard.Length; i++) {
                try { Close(ref standard[i]); } catch { settled = false; failure = "Standard handle cleanup failed."; }
            }
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            try { Close(ref job); } catch { settled = false; failure = "Owned job handle cleanup failed."; }
        }
        if (!created) receipts.WriteLine("not-started " + Encoded(failure));
        else receipts.WriteLine("finished " + child.dwProcessId + " " + (exitCode.HasValue ? exitCode.Value.ToString() : "-") +
            " " + (settled ? "settled" : "unconfirmed") + " " + (resumed ? "resumed" : "suspended") + " " + Encoded(failure));
    }
}
}
