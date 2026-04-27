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
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
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
