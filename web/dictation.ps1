$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if (-not $recognizer) { exit 2 }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
$wave = New-Object System.IO.MemoryStream
try {
    [Console]::OpenStandardInput().CopyTo($wave)
    $wave.Position = 0
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveStream($wave)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    do {
        try { $result = $engine.Recognize() }
        catch [System.InvalidOperationException] {
            if ($wave.Position -eq $wave.Length) { break }
            throw
        }
        if ($result) { [Console]::Write($result.Text) }
    } while ($result)
} finally { $engine.Dispose(); $wave.Dispose() }
