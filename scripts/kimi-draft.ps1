#Requires -Version 7.0
<#
.SYNOPSIS
Runs one public-input Kimi draft with a reviewed, explicitly supplied skills folder.
.DESCRIPTION
GPT must review the prompt and every supplied skill before invocation. This is a
bounded CLI wrapper, not an OS sandbox. Existing Kimi OAuth/config/session storage
remains in the user's home; nothing from that home is copied to the output.
OutputDirectory must be NEW, outside all Git checkouts, without ancestor project
instructions/configuration. Raw output stays in its owner-only directory.
Exit codes: 0 success; 2 rejected preflight; 124 timeout; otherwise CLI exit code
(or 1 for a local process/capture failure). No generated draft is applied.
Offline process check (does not invoke Kimi):
  . ./scripts/kimi-draft.ps1
  Test-KimiDraftProcess
#>
[CmdletBinding()]
param(
    [string] $PromptFile,
    [string] $SkillsDirectory,
    [string] $OutputDirectory,
    [ValidateRange(30, 1200)][int] $TimeoutSeconds = 600
)

function Invoke-KimiBoundedProcess {
    param([string] $Executable, [string[]] $Arguments, [string] $WorkingDirectory,
        [hashtable] $ChildEnvironment, [int] $Seconds, [string] $LogPrefix)
    $start = [System.Diagnostics.ProcessStartInfo]::new($Executable)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = $WorkingDirectory
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    # Do not inherit model, endpoint, update, or experimental Kimi overrides.
    foreach ($key in @($start.Environment.Keys)) {
        if ($key -like 'KIMI_*') { [void] $start.Environment.Remove($key) }
    }
    foreach ($key in $ChildEnvironment.Keys) { $start.Environment[$key] = $ChildEnvironment[$key] }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    $stdoutFile = $null
    $stderrFile = $null
    $started = $false
    $timedOut = $false
    try {
        $stdoutFile = [IO.File]::Open("$LogPrefix.stdout", [IO.FileMode]::CreateNew)
        $stderrFile = [IO.File]::Open("$LogPrefix.stderr", [IO.FileMode]::CreateNew)
        $started = $process.Start()
        $process.StandardInput.Close()
        # Concurrent stream draining prevents either full pipe from deadlocking.
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
        $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrFile)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not $process.WaitForExit(100)) {
            if ($clock.Elapsed.TotalSeconds -ge $Seconds) {
                $timedOut = $true
                $process.Kill($true) # This handle and its descendants only.
                if (-not $process.WaitForExit(5000)) { throw 'Child did not stop.' }
                break
            }
        }
        if (-not [Threading.Tasks.Task]::WaitAll(
            [Threading.Tasks.Task[]] @($stdoutTask, $stderrTask), 5000)) {
            throw 'Output streams did not close.'
        }
        if ($timedOut) { return 124 }
        return $process.ExitCode
    }
    finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            [void] $process.WaitForExit(5000)
        }
        if ($null -ne $stdoutFile) { $stdoutFile.Dispose() }
        if ($null -ne $stderrFile) { $stderrFile.Dispose() }
        $process.Dispose()
    }
}

function Assert-KimiPlainPath([string] $Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathFullyQualified($Path) -or
        $Path.StartsWith('\\')) { throw 'Use explicit absolute local paths.' }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $cursor = $fullPath
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Symlinks and junctions are not allowed in supplied paths.'
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $fullPath
}

function Assert-KimiThinking([string] $ConfigPath) {
    # Native 2.1.1 has no thinking-on CLI/env override. Never infer it from effort.
    # Accept only the unambiguous ordinary TOML section; reject complex syntax.
    $config = [IO.File]::ReadAllText($ConfigPath)
    if ($config -match '(?m)^\s*(?:\[\[?\s*["'']?hooks|["'']?hooks["'']?\s*[.=])') {
        throw 'Lifecycle hooks require separate review before using this runner.'
    }
    if ($config.Contains('"""') -or $config.Contains("'''" ) -or
        $config -match '(?m)^\s*(?:["'']?thinking["'']?\s*[.=]|default_thinking\s*=)') {
        throw 'Thinking preflight requires an ordinary [thinking] section.'
    }
    $sections = [regex]::Matches($config, '(?ms)^\s*\[thinking\]\s*(?:#[^\r\n]*)?\r?\n(?<body>.*?)(?=^\s*\[|\z)')
    if ($sections.Count -ne 1) { throw 'Explicit [thinking] enabled=true is required.' }
    $settings = [regex]::Matches($sections[0].Groups['body'].Value, '(?m)^\s*enabled\s*=\s*(?<value>true|false)\s*(?:#[^\r\n]*)?$')
    if ($settings.Count -ne 1 -or $settings[0].Groups['value'].Value -cne 'true') {
        throw 'Explicit [thinking] enabled=true is required.'
    }
}

function Test-KimiDraftProcess {
    # A local pwsh child stands in for Kimi: exercise literal arguments, both
    # pipes, child-only environment, nonzero exit, and enforced cancellation.
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('kimi-runner-check-' + [guid]::NewGuid())
    [void] [IO.Directory]::CreateDirectory($directory)
    try {
        $fake = Join-Path $directory 'fake.ps1'
        [IO.File]::WriteAllText($fake, 'param($Literal) [Console]::Out.Write($Literal + $env:KIMI_RUNNER_CHECK + ("x" * 70000)); [Console]::Error.Write("y" * 70000); exit 7')
        $literal = 'spaces "quotes" $() & ; literal'
        $code = Invoke-KimiBoundedProcess (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile', '-File', $fake, $literal) $directory @{KIMI_RUNNER_CHECK='child'} 10 (Join-Path $directory 'normal')
        if ($code -ne 7 -or -not [IO.File]::ReadAllText((Join-Path $directory 'normal.stdout')).StartsWith($literal + 'child') -or
            (Get-Item -LiteralPath (Join-Path $directory 'normal.stderr')).Length -ne 70000 -or $env:KIMI_RUNNER_CHECK) {
            throw 'Literal arguments, stream drain, exit, or environment check failed.'
        }
        $code = Invoke-KimiBoundedProcess (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') $directory @{} 1 (Join-Path $directory 'timeout')
        if ($code -ne 124) { throw 'Timeout check failed.' }
        $configFile = Join-Path $directory 'config.toml'
        foreach ($sample in @(
            @{ Text="[thinking]`nenabled = true`n"; Accept=$true },
            @{ Text="[thinking]`nenabled = false`n"; Accept=$false },
            @{ Text="[thinking]`neffort = 'max'`n"; Accept=$false },
            @{ Text="[thinking]`nenabled = true`n[[hooks]]`n"; Accept=$false }
        )) {
            [IO.File]::WriteAllText($configFile, $sample.Text)
            $accepted = $true
            try { Assert-KimiThinking $configFile } catch { $accepted = $false }
            if ($accepted -ne $sample.Accept) { throw 'Thinking/hooks preflight check failed.' }
        }
        Write-Output 'Offline process checks passed; no Kimi invocation or quota used.'
    }
    finally {
        # This path is a fresh random child of the known temporary directory.
        if ([IO.Path]::GetDirectoryName($directory).TrimEnd('\') -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unexpected check directory.' }
        Remove-Item -LiteralPath $directory -Recurse -Force
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
$phase = 'preflight'
try {
    if (-not $IsWindows) { throw 'This reviewed native CLI runner requires Windows PowerShell 7.' }
    $promptPath = Assert-KimiPlainPath $PromptFile
    $skillsPath = Assert-KimiPlainPath $SkillsDirectory
    $outputPath = Assert-KimiPlainPath $OutputDirectory
    $repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $kimiHomePath = Join-Path $env:USERPROFILE '.kimi-code'
    $executable = Join-Path $kimiHomePath 'bin\kimi.exe'
    $agentPath = Join-Path $repoPath 'agents\kimi-skill-drafter.md'
    if (-not (Test-Path -LiteralPath $promptPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $skillsPath -PathType Container) -or
        -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'A required explicit input or installed CLI is missing.' }
    if (Test-Path -LiteralPath $outputPath) { throw 'OutputDirectory must be a new directory.' }
    if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($outputPath)) -PathType Container)) { throw 'OutputDirectory parent must already exist.' }
    $cursor = [IO.DirectoryInfo]::new($outputPath)
    while ($null -ne $cursor) {
        foreach ($name in @('.git', 'AGENTS.md', '.kimi-code\AGENTS.md', '.agents\AGENTS.md', '.mcp.json', '.kimi-code\mcp.json')) {
            if (Test-Path -LiteralPath (Join-Path $cursor.FullName $name)) { throw 'Output has a Git, instruction, or MCP ancestor.' }
        }
        $cursor = $cursor.Parent
    }
    foreach ($path in @($promptPath, $skillsPath, $outputPath)) {
        foreach ($privateRoot in @($kimiHomePath, (Join-Path $env:USERPROFILE '.ssh'), (Join-Path $env:USERPROFILE '.codex'), (Join-Path $env:USERPROFILE '.agents'))) {
            if ($path.Equals($privateRoot, [StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($privateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Private home directories cannot be task inputs or output.'
            }
        }
    }
    foreach ($instruction in @((Join-Path $kimiHomePath 'AGENTS.md'), (Join-Path $kimiHomePath 'SYSTEM.md'),
        (Join-Path $kimiHomePath 'mcp.json'), (Join-Path $kimiHomePath 'plugins\installed.json'),
        (Join-Path $env:USERPROFILE '.agents\AGENTS.md'))) {
        if (Test-Path -LiteralPath $instruction) { throw 'Global instructions, MCP, or plugins require separate review before using this runner.' }
    }
    $skillFiles = @(Get-ChildItem -LiteralPath $skillsPath -Recurse -Force -File)
    if (-not ($skillFiles | Where-Object Name -CEQ 'SKILL.md')) { throw 'Supply an explicitly reviewed folder containing SKILL.md files.' }
    foreach ($entry in @(Get-ChildItem -LiteralPath $skillsPath -Recurse -Force)) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Name.StartsWith('.') -or
            (-not $entry.PSIsContainer -and $entry.Extension -ine '.md')) { throw 'Reviewed skills may contain only ordinary Markdown files and directories.' }
    }
    $agent = [IO.File]::ReadAllText($agentPath).Replace("`r`n", "`n")
    if ($agent -notmatch '\A---\nname: foundation-drafter\ndescription: [^\n]+\ntools:\n  - Skill\nsubagents: \[\]\n---\n' -or
        @([regex]::Matches($agent, '\$\{[^}]+\}') | Where-Object Value -CNE '${skills}').Count -ne 0) {
        throw 'The fixed agent must expose only Skill, no subagents, and only the skills template.'
    }
    Assert-KimiThinking (Join-Path $kimiHomePath 'config.toml')
    $prompt = [IO.File]::ReadAllText($promptPath)
    # ponytail: Windows command-line ceiling; split larger work into bounded drafts.
    if ([string]::IsNullOrWhiteSpace($prompt) -or $prompt.Length -gt 20000 -or $prompt.Contains([char]0)) { throw 'Public prompt must contain 1..20000 characters, without NUL.' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    [void] [IO.FileSystemAclExtensions]::CreateDirectory($acl, $outputPath)
    $childEnvironment = @{
        KIMI_CODE_HOME = $kimiHomePath
        KIMI_MODEL_THINKING_EFFORT = 'max'
        KIMI_MODEL_THINKING_KEEP = 'all'
        KIMI_LOOP_MAX_ATTEMPTS_PER_STEP = '2'
        KIMI_LOOP_MAX_STEPS_PER_TURN = '8'
        KIMI_CODE_INFINITE_RETRY = '0'
        KIMI_CODE_NO_AUTO_UPDATE = '1'
        KIMI_DISABLE_TELEMETRY = '1'
        KIMI_DISABLE_CRON = '1'
        KIMI_CODE_BUILTIN_PRODUCT_SKILLS = '0'
        KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT = '0'
        KIMI_CODE_WATCH = '0'
        NO_COLOR = '1'
    }
    $phase = 'version check'
    $code = Invoke-KimiBoundedProcess $executable @('--version') $outputPath $childEnvironment 30 (Join-Path $outputPath 'version')
    if ($code -ne 0) { exit $code }
    if ([IO.File]::ReadAllText((Join-Path $outputPath 'version.stdout')).Trim() -cne '2.1.1') { throw 'Only reviewed CLI version 2.1.1 is supported.' }
    $phase = 'draft'
    $code = Invoke-KimiBoundedProcess $executable @('--agent-file', $agentPath, '--skills-dir', $skillsPath, '-m', 'kimi-code/k3-256k', '--output-format', 'stream-json', '-p', $prompt) $outputPath $childEnvironment $TimeoutSeconds (Join-Path $outputPath 'draft')
    Write-Output "Kimi draft finished with exit code $code. Review private output files before applying changes."
    exit $code
}
catch {
    # Do not print exception/config/prompt contents; even CLI errors can contain secrets.
    [Console]::Error.WriteLine("Kimi runner stopped during $phase. Review inputs and runner prerequisites locally; no draft was applied.")
    if ($phase -eq 'preflight' -or $phase -eq 'version check') { exit 2 }
    exit 1
}
