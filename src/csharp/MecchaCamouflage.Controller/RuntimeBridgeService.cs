using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using MecchaCamouflage.Core;

namespace MecchaCamouflage.Controller;

/// <summary>
/// Stages and starts one uniquely named direct bridge per attempt. Existing bridge modules are
/// intentionally outside this service's control: they are neither enumerated, switched,
/// unloaded, nor used as a reason to require a game restart.
/// </summary>
public sealed class RuntimeBridgeService
{
    public static readonly TimeSpan BridgeProbeTimeout = TimeSpan.FromMilliseconds(300);

    private readonly AppPaths paths;
    private readonly RuntimeLog log;
    private BridgeInstance? activeInstance;
    private string waitingForProcessName = "";
    private string lastBridgeReadyLogKey = "";
    private bool bridgeReadyTimeoutLogged;
    private bool bridgeConnected;

    public RuntimeBridgeService(AppPaths paths, RuntimeLog log)
    {
        this.paths = paths;
        this.log = log;
    }

    public string BridgePath => activeInstance?.BridgePath ?? "";
    public string ProgressPath => activeInstance?.ProgressPath ?? "";
    public bool IsConnected => bridgeConnected;

    /// <summary>
    /// Resolves the configured process name for the current UI flow. Once selected, the exact
    /// <see cref="Process"/> identity is captured and passed to the injector; the injector never
    /// receives this name and never performs its own process-name lookup.
    /// </summary>
    public Process? FindGameProcess(string processName)
    {
        var name = Path.GetFileNameWithoutExtension(processName);
        return Process.GetProcessesByName(name).OrderBy(process => process.Id).FirstOrDefault();
    }

    public Task<BridgeReply> PingAsync(CancellationToken cancellationToken = default, TimeSpan? timeoutOverride = null) =>
        RequestActiveAsync(client => client.PingAsync(cancellationToken, timeoutOverride));

    public Task<BridgeReply> CancelPaintAsync(CancellationToken cancellationToken = default) =>
        RequestActiveAsync(client => client.CancelPaintAsync(cancellationToken));

    public Task<BridgeReply> SendPaintAsync(string payload, CancellationToken cancellationToken = default) =>
        RequestActiveAsync(client => client.RequestAsync(payload, cancellationToken));

    public async Task<BridgeReply> ShutdownAsync(CancellationToken cancellationToken = default)
    {
        var reply = await RequestActiveAsync(client => client.ShutdownAsync(cancellationToken));
        if (reply.Ok && reply.Success)
            bridgeConnected = false;
        return reply;
    }

    public async Task<bool> EnsureReadyAsync(string processName, CancellationToken cancellationToken = default)
    {
        var process = FindGameProcess(processName);
        if (process is null)
        {
            bridgeConnected = false;
            if (!string.Equals(waitingForProcessName, processName, StringComparison.OrdinalIgnoreCase))
            {
                log.Warn($"Game process: waiting for {processName}.");
                waitingForProcessName = processName;
            }
            return false;
        }

        using (process)
            return await EnsureReadyAsync(process, cancellationToken);
    }

    /// <summary>Starts a bridge for an explicitly selected PID after recapturing its identity.</summary>
    public async Task<bool> EnsureReadyAsync(int selectedProcessId, CancellationToken cancellationToken = default)
    {
        try
        {
            using var process = Process.GetProcessById(selectedProcessId);
            return await EnsureReadyAsync(process, cancellationToken);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            bridgeConnected = false;
            DiagnosticsState.SetLastCode("MC-INJ-102", ex.Message);
            log.Warn($"Game process: selected pid={selectedProcessId} is no longer available.");
            return false;
        }
    }

    /// <summary>
    /// Starts a bridge for the exact process selected by the caller. The process instance is not
    /// retained; its PID, creation FILETIME, and executable path are captured once and passed to
    /// the injector for independent verification.
    /// </summary>
    public async Task<bool> EnsureReadyAsync(Process selectedProcess, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(selectedProcess);
        TargetProcessIdentity target;
        try
        {
            target = CaptureTargetIdentity(selectedProcess);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or UnauthorizedAccessException)
        {
            bridgeConnected = false;
            DiagnosticsState.SetLastCode("MC-INJ-102", ex.Message);
            log.Error("Bridge: could not read the selected game process identity: " + FriendlyAccessFailure(ex.Message));
            return false;
        }

        return await EnsureReadyAsync(target, cancellationToken);
    }

    /// <summary>Uses an already captured exact identity; the injector verifies it again before injection.</summary>
    public async Task<bool> EnsureReadyAsync(TargetProcessIdentity target, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        waitingForProcessName = "";
        if (ActiveInstanceMatches(target))
        {
            var ping = await PingAsync(cancellationToken, BridgeProbeTimeout);
            if (IsBridgeReadyForInstance(ping, activeInstance!))
            {
                bridgeReadyTimeoutLogged = false;
                RestoreConnectedState(activeInstance!);
                return true;
            }
            bridgeConnected = false;
        }

        return await InjectDirectInstanceAsync(target, cancellationToken);
    }

    private Task<bool> InjectDirectInstanceAsync(TargetProcessIdentity target, CancellationToken cancellationToken) =>
        // Mutex ownership is thread-affine. Keep the complete critical section on one worker
        // thread so asynchronous injector/network continuations cannot release it elsewhere.
        Task.Run(() => InjectDirectInstanceOnMutexThread(target, cancellationToken), CancellationToken.None);

    private bool InjectDirectInstanceOnMutexThread(TargetProcessIdentity target, CancellationToken cancellationToken)
    {
        var mutexName = $@"Local\MecchaCamouflage.Inject.{target.ProcessId}";
        using var mutex = new Mutex(false, mutexName);
        var ownsMutex = false;
        try
        {
            try
            {
                ownsMutex = mutex.WaitOne(TimeSpan.FromSeconds(1));
            }
            catch (AbandonedMutexException)
            {
                ownsMutex = true;
            }
            if (!ownsMutex)
            {
                DiagnosticsState.SetBridgeInjection($"waiting for another direct injection pid={target.ProcessId}");
                return false;
            }

            BridgeInstance instance;
            try
            {
                instance = PrepareDirectBridgeInstance(target);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or DirectoryNotFoundException or FileNotFoundException)
            {
                bridgeConnected = false;
                DiagnosticsState.SetLastCode("MC-RT-001", ex.Message);
                DiagnosticsState.SetBridgeInjection("direct bridge staging failed");
                log.Error("Bridge: runtime files could not be staged: " + FriendlyAccessFailure(ex.Message));
                return false;
            }

            LogTargetProcess(target);
            DiagnosticsState.SetBridgeInjection($"direct-injecting pid={target.ProcessId} instance={instance.InstanceId:N}");
            var invocation = InvokeDirectInjectorAsync(instance, cancellationToken).GetAwaiter().GetResult();
            if (invocation.Canceled)
            {
                bridgeConnected = false;
                DiagnosticsState.SetLastCode("MC-INJ-131", "injector wait was canceled; target memory ownership is indeterminate");
                DiagnosticsState.SetBridgeInjection($"direct injector canceled pid={target.ProcessId}");
                log.Warn("Bridge: injection was canceled while the target operation may still be running. Retry explicitly when ready.");
                return false;
            }
            if (!invocation.Parsed || invocation.Result is null || !invocation.Result.Matches(target.ProcessId, instance.InstanceId, instance.ExpectedBridgeHash))
            {
                bridgeConnected = false;
                var result = invocation.Result;
                var detail = result?.Detail;
                if (string.IsNullOrWhiteSpace(detail))
                    detail = invocation.ParseError;
                var code = result?.State.Equals("indeterminate_timeout", StringComparison.OrdinalIgnoreCase) == true ? "MC-INJ-132" : "MC-INJ-130";
                DiagnosticsState.SetLastCode(code, detail ?? "injector did not return a matching direct bridge result");
                DiagnosticsState.SetBridgeInjection($"direct injection failed pid={target.ProcessId} state={result?.State ?? "protocol_error"}");
                log.Error("Bridge: direct injection failed: " + FriendlyInjectorFailure(invocation));
                return false;
            }

            instance.SetPort(invocation.Result.BoundPort!.Value);
            activeInstance = instance;
            var ping = PingAsync(cancellationToken, TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
            if (IsBridgeReadyForInstance(ping, instance))
            {
                bridgeReadyTimeoutLogged = false;
                RestoreConnectedState(instance);
                return true;
            }

            bridgeConnected = false;
            DiagnosticsState.SetLastCode("MC-INJ-145", ping.Message);
            DiagnosticsState.SetBridgeInjection($"direct bridge hello failed pid={target.ProcessId} instance={instance.InstanceId:N}");
            if (!bridgeReadyTimeoutLogged)
            {
                bridgeReadyTimeoutLogged = true;
                log.Error("Bridge: direct bridge started but its authenticated hello did not complete.");
            }
            return false;
        }
        finally
        {
            if (ownsMutex)
                mutex.ReleaseMutex();
        }
    }

    private BridgeInstance PrepareDirectBridgeInstance(TargetProcessIdentity target)
    {
        paths.EnsureBaseDirectories();
        var nativeRoot = PackagedAssets.ResolveRequiredAssetRoot(paths, "native", log);
        var profilesRoot = PackagedAssets.ResolveRequiredAssetRoot(paths, "mesh-profiles", log);
        var bridgeSource = ResolvePackagedNativeAsset(nativeRoot, "runtime-bridge.dll");
        var injectorSource = ResolvePackagedNativeAsset(nativeRoot, "runtime-injector.exe");
        if (!File.Exists(bridgeSource) || !File.Exists(injectorSource))
            throw new FileNotFoundException("Packaged direct bridge or injector is missing.");

        var instanceId = Guid.NewGuid();
        var token = RandomNumberGenerator.GetBytes(BridgeStartBlockV1.TokenLength);
        var hash = PackagedAssets.Sha256File(bridgeSource).ToLowerInvariant();
        var instanceDirectory = Path.Combine(paths.BridgeInstancesDirectory, BridgeInstanceNaming.CreateDirectoryName(instanceId));
        Directory.CreateDirectory(instanceDirectory);

        var bridgePath = Path.Combine(instanceDirectory, BridgeInstanceNaming.CreateBridgeFileName(hash, instanceId));
        var injectorPath = Path.Combine(instanceDirectory, "runtime-injector.exe");
        PackagedAssets.CopyIfInvalid(bridgeSource, bridgePath);
        PackagedAssets.CopyIfInvalid(injectorSource, injectorPath);
        CopyMeshProfiles(profilesRoot, instanceDirectory);

        var progressPath = bridgePath + ".progress.json";
        var instance = new BridgeInstance(target, instanceId, token, hash, bridgePath, injectorPath, progressPath);
        LogRuntimeFilesPrepared(instance);
        return instance;
    }

    private async Task<InjectorInvocation> InvokeDirectInjectorAsync(BridgeInstance instance, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(instance.InjectorPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true
        };
        start.ArgumentList.Add("--direct");
        start.ArgumentList.Add(instance.Target.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        start.ArgumentList.Add(instance.Target.CreationTimeUtcFileTime.ToString(System.Globalization.CultureInfo.InvariantCulture));
        start.ArgumentList.Add(instance.Target.ExecutablePath);
        start.ArgumentList.Add(instance.BridgePath);

        var startBlock = BridgeStartBlockV1.Create(
            instance.Target.ProcessId,
            instance.InstanceId,
            instance.ConnectionToken,
            Convert.FromHexString(instance.ExpectedBridgeHash));
        Process? injector;
        try
        {
            injector = Process.Start(start);
        }
        catch (Exception ex) when (ex is Win32Exception or UnauthorizedAccessException or InvalidOperationException)
        {
            return new InjectorInvocation(false, false, null, ex.Message, "");
        }
        if (injector is null)
            return new InjectorInvocation(false, false, null, "could not start the direct injector", "");
        using (injector)
        {
            var stdoutTask = injector.StandardOutput.ReadToEndAsync();
            var stderrTask = injector.StandardError.ReadToEndAsync();

            try
            {
                await injector.StandardInput.BaseStream.WriteAsync(startBlock.Serialize(), cancellationToken);
                await injector.StandardInput.BaseStream.FlushAsync(cancellationToken);
                injector.StandardInput.Close();
                await injector.WaitForExitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                TryCloseStandardInput(injector);
                _ = ObserveInjectorOutputAsync(stdoutTask, stderrTask);
                return new InjectorInvocation(true, false, null, "injector operation canceled", "");
            }
            catch (Exception ex) when (ex is IOException or Win32Exception or InvalidOperationException)
            {
                TryCloseStandardInput(injector);
                _ = ObserveInjectorOutputAsync(stdoutTask, stderrTask);
                return new InjectorInvocation(false, false, null, ex.Message, "");
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            LogInjectorOutput(stdout, stderr);
            if (!InjectorResultV1.TryParseFinal(stdout, out var result, out var parseError))
                return new InjectorInvocation(false, false, null, parseError, stderr);
            return new InjectorInvocation(false, true, result, "", stderr);
        }
    }

    private async Task<BridgeReply> RequestActiveAsync(Func<BridgeClient, Task<BridgeReply>> request)
    {
        var instance = activeInstance;
        if (instance?.Port is not int)
            return new BridgeReply(false, false, "not_connected", "Bridge is not connected.", "");
        var reply = await request(new BridgeClient(instance.Endpoint, instance.Target.ProcessId));
        bridgeConnected = IsBridgeReadyForInstance(reply, instance) || (reply.Ok && reply.InstanceId == instance.InstanceId);
        return reply;
    }

    private static bool IsBridgeReadyForInstance(BridgeReply reply, BridgeInstance instance) =>
        reply.Ok &&
        reply.Success &&
        reply.ProcessId == instance.Target.ProcessId &&
        reply.InstanceId == instance.InstanceId &&
        string.Equals(reply.BridgeHash, instance.ExpectedBridgeHash, StringComparison.OrdinalIgnoreCase) &&
        reply.ProtocolVersion == BridgeProtocolV1.Version;

    private bool ActiveInstanceMatches(TargetProcessIdentity target) =>
        activeInstance is not null &&
        activeInstance.Target.ProcessId == target.ProcessId &&
        activeInstance.Target.CreationTimeUtcFileTime == target.CreationTimeUtcFileTime &&
        string.Equals(activeInstance.Target.ExecutablePath, target.ExecutablePath, StringComparison.OrdinalIgnoreCase) &&
        activeInstance.Port is not null;

    private static TargetProcessIdentity CaptureTargetIdentity(Process process)
    {
        if (process.HasExited)
            throw new InvalidOperationException("The selected game process exited.");
        var executablePath = process.MainModule?.FileName;
        if (string.IsNullOrWhiteSpace(executablePath))
            throw new InvalidOperationException("The selected game executable path is unavailable.");
        return TargetProcessIdentity.Create(process.Id, process.StartTime.ToUniversalTime().ToFileTimeUtc(), executablePath);
    }

    private static string ResolvePackagedNativeAsset(string root, string fileName)
    {
        var inNativeDirectory = Path.Combine(root, "native", fileName);
        return File.Exists(inNativeDirectory) ? inNativeDirectory : Path.Combine(root, fileName);
    }

    private static void CopyMeshProfiles(string profilesRoot, string instanceDirectory)
    {
        var source = Path.Combine(profilesRoot, "mesh-profiles");
        if (!Directory.Exists(source))
            return;
        var target = Path.Combine(instanceDirectory, "mesh-profiles");
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source, "*.json", SearchOption.TopDirectoryOnly))
            PackagedAssets.CopyIfInvalid(file, Path.Combine(target, Path.GetFileName(file)));
    }

    private void RestoreConnectedState(BridgeInstance instance)
    {
        bridgeConnected = true;
        var key = $"{instance.Target.ProcessId}:{instance.InstanceId:N}:{instance.Port}";
        if (string.Equals(lastBridgeReadyLogKey, key, StringComparison.Ordinal))
            return;
        lastBridgeReadyLogKey = key;
        DiagnosticsState.SetBridgeInjection($"ready pid={instance.Target.ProcessId} instance={instance.InstanceId:N} port={instance.Port}");
        log.Info($"Bridge: connected to direct instance in game process pid={instance.Target.ProcessId}.");
    }

    private void LogRuntimeFilesPrepared(BridgeInstance instance)
    {
        log.Info("Bridge: staged direct instance.");
        if (!ResearchArtifactsEnabled())
            return;
        LogRuntimeFileDetails("bridge", instance.BridgePath);
        LogRuntimeFileDetails("injector", instance.InjectorPath);
    }

    private void LogTargetProcess(TargetProcessIdentity target)
    {
        log.Info($"Game process: selected pid={target.ProcessId}.");
        if (ResearchArtifactsEnabled())
            log.Info($"Game process detail: created={DateTimeOffset.FromFileTime(target.CreationTimeUtcFileTime):O} path={target.ExecutablePath}");
    }

    private void LogRuntimeFileDetails(string label, string path)
    {
        var info = new FileInfo(path);
        log.Info($"Bridge detail: {label} {path} ({info.Length} bytes sha256={PackagedAssets.Sha256File(path)[..16]})");
    }

    private void LogInjectorOutput(string stdout, string stderr)
    {
        if (ResearchArtifactsEnabled())
        {
            foreach (var line in SplitLines(stdout))
                log.Info("Bridge detail: injector " + line);
        }
        foreach (var line in SplitLines(stderr))
            log.Warn("Bridge detail: injector " + line);
    }

    private static async Task ObserveInjectorOutputAsync(Task<string> stdoutTask, Task<string> stderrTask)
    {
        try
        {
            await Task.WhenAll(stdoutTask, stderrTask);
        }
        catch
        {
            // The process and its remote work are deliberately not terminated on host cancellation.
        }
    }

    private static void TryCloseStandardInput(Process injector)
    {
        try { injector.StandardInput.Close(); } catch { }
    }

    private static IEnumerable<string> SplitLines(string value) =>
        value.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .Where(line => line.Length > 0);

    private static string FriendlyInjectorFailure(InjectorInvocation invocation)
    {
        if (invocation.Result?.State.Equals("indeterminate_timeout", StringComparison.OrdinalIgnoreCase) == true)
            return "the remote operation did not finish. Its target memory was intentionally retained; retry explicitly after confirming the game is responsive.";
        var detail = invocation.Result?.Detail;
        if (string.IsNullOrWhiteSpace(detail))
            detail = invocation.ParseError;
        if (string.IsNullOrWhiteSpace(detail))
            detail = invocation.StandardError;
        var lower = detail.ToLowerInvariant();
        if (lower.Contains("access denied") || lower.Contains("win32=5"))
            return "access denied while opening the selected game process. Run Meccha Camouflage with the same privileges as the game, or try Run as administrator.";
        return detail;
    }

    private static string FriendlyAccessFailure(string message)
    {
        var lower = message.ToLowerInvariant();
        if (lower.Contains("access") || lower.Contains("permission") || lower.Contains("denied"))
            return message + " Run Meccha Camouflage with access to its runtime folder.";
        return message;
    }

    private static bool ResearchArtifactsEnabled() =>
        string.Equals(Environment.GetEnvironmentVariable("MECCHA_RESEARCH_ARTIFACTS"), "1", StringComparison.Ordinal);

    private sealed record InjectorInvocation(bool Canceled, bool Parsed, InjectorResultV1? Result, string ParseError, string StandardError);
}
