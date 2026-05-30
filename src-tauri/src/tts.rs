// Text-to-speech for time-critical in-game audio cues.
// macOS uses the built-in `say` command; Windows uses SAPI via PowerShell.
// Errors are swallowed silently — TTS is best-effort and must never block gameplay.

use std::process::Command;

// Default English voice. Samantha is shipped with all modern macOS by default.
// User can override by setting QUERYLOL_TTS_VOICE env var (e.g. "Daniel" for UK).
#[cfg(target_os = "macos")]
const MACOS_VOICE: &str = "Samantha";

#[cfg(target_os = "macos")]
pub fn speak(text: &str) {
    let text = sanitize(text);
    if text.is_empty() {
        return;
    }
    let voice = std::env::var("QUERYLOL_TTS_VOICE").unwrap_or_else(|_| MACOS_VOICE.to_string());
    let _ = Command::new("say")
        .args(["-v", &voice, "-r", "220"])
        .arg(&text)
        .spawn();
}

#[cfg(target_os = "windows")]
pub fn speak(text: &str) {
    let text = sanitize(text);
    if text.is_empty() {
        return;
    }
    // Escape single quotes for PowerShell string literal
    let escaped = text.replace('\'', "''");
    // Force an en-US voice if one is installed; fall back to default voice otherwise.
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.Rate = 2; \
         try {{ $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female, [System.Speech.Synthesis.VoiceAge]::Adult, 0, (New-Object System.Globalization.CultureInfo 'en-US')) }} catch {{}}; \
         $s.Speak('{}')",
        escaped
    );
    // CREATE_NO_WINDOW (0x08000000): never create a console window for the
    // child process. Without this, launching powershell.exe briefly spawns a
    // conhost window that steals focus — which kicks fullscreen games out of
    // exclusive fullscreen mode. `-WindowStyle Hidden` is NOT enough: it only
    // hides the window after it has already been created and grabbed focus.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn speak(_text: &str) {
    // Unsupported platform — no-op
}

// Strip control chars and limit length to keep audio short and avoid command injection vectors.
fn sanitize(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect()
}
