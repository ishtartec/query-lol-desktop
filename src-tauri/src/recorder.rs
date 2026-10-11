//! Game recording. Spike: captures one window with ScreenCaptureKit and
//! encodes it ourselves through `AVAssetWriter`, which uses the hardware
//! encoder. `SCRecordingOutput` would write the file for us, but it has no
//! bitrate setting: 1920px at 60fps measured 24 Mbps in game (~5 GB per
//! 35-minute game), and dropping to 1280px at 30fps only halved that.
//!
//! H.264 rather than HEVC because WebView2 on Windows only plays HEVC with an
//! optional extension, and recordings should play on both platforms.

use crate::models::{GoldDiffPoint, KeyMoment};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct CaptureWindow {
    pub window_id: u32,
    pub app_name: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub on_screen: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingResult {
    pub path: PathBuf,
    pub bytes: i64,
    pub duration_secs: f64,
}

/// What `start` matches against "app name - window title" when no query is
/// given. Unverified: confirm the game's real names with `list_windows`.
pub const DEFAULT_WINDOW_QUERY: &str = "League of Legends (TM) Client";

#[cfg(target_os = "macos")]
mod imp {
    use super::{CaptureWindow, RecordingResult};
    use avassetwriter::prelude::*;
    use avassetwriter::writer::MediaType;
    use screencapturekit::cm::{CMSampleBufferSCExt, CMTime, SCFrameStatus};
    use screencapturekit::prelude::*;
    use screencapturekit::shareable_content::ContentSnapshot;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, Once};

    /// Longest output edge. Retina windows report points, so a full-screen
    /// game on a 14" MacBook would otherwise record at 3024px wide.
    const MAX_WIDTH: f64 = 1920.0;
    const FPS: u32 = 60;
    /// ffmpeg's VideoToolbox encoder at 6 Mbps kept the HUD as legible as the
    /// 24 Mbps original.
    const VIDEO_BITRATE: u32 = 6_000_000;
    const AUDIO_BITRATE: u32 = 128_000;
    /// A keyframe every 2s keeps seeking from an event cheap and exact.
    const KEYFRAME_SECS: u32 = 2;

    /// Shared between the capture callbacks (video and audio arrive on
    /// separate queues) and `stop`.
    struct Sink {
        writer: Mutex<Option<Writer>>,
        video: InputId,
        audio: InputId,
        /// Presentation time of the first frame; audio before it is dropped
        /// and the session starts there.
        first: Mutex<Option<CMTime>>,
        /// Wall-clock time of the first frame, i.e. of video time zero.
        first_at: Mutex<Option<std::time::Instant>>,
        last_secs: Mutex<f64>,
        frames: AtomicU64,
        dropped: AtomicU64,
    }

    impl Sink {
        fn on_video(&self, sample: &CMSampleBuffer) {
            // Idle frames carry no image: the window did not change.
            if sample.frame_status() != Some(SCFrameStatus::Complete) {
                return;
            }
            let guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            let Some(writer) = guard.as_ref() else { return };
            let pts = sample.presentation_timestamp();
            {
                let mut first = self.first.lock().unwrap_or_else(|e| e.into_inner());
                if first.is_none() {
                    if let Err(e) = writer.start_session(pts) {
                        log::error!("recording: start_session failed: {e:?}");
                        return;
                    }
                    *first = Some(pts);
                    *self.first_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
                }
                if let Some(f) = *first {
                    *self.last_secs.lock().unwrap_or_else(|e| e.into_inner()) = secs(pts) - secs(f);
                }
            }
            match writer.append_sample(self.video, sample) {
                Ok(()) => {
                    self.frames.fetch_add(1, Ordering::Relaxed);
                }
                // Encoder is behind: drop the frame rather than stall capture.
                Err(AVWriterError::InputNotReady) => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
                Err(e) => log::warn!("recording: video append failed: {e:?}"),
            }
        }

        fn on_audio(&self, sample: &CMSampleBuffer) {
            let started = self.first.lock().unwrap_or_else(|e| e.into_inner()).is_some();
            if !started {
                return;
            }
            let guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(writer) = guard.as_ref() {
                match writer.append_sample(self.audio, sample) {
                    Ok(()) | Err(AVWriterError::InputNotReady) => {}
                    Err(e) => log::warn!("recording: audio append failed: {e:?}"),
                }
            }
        }
    }

    fn secs(t: CMTime) -> f64 {
        if t.timescale > 0 {
            t.value as f64 / f64::from(t.timescale)
        } else {
            0.0
        }
    }

    struct Handler(Arc<Sink>);

    impl SCStreamOutputTrait for Handler {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
            match kind {
                SCStreamOutputType::Screen => self.0.on_video(&sample),
                SCStreamOutputType::Audio => self.0.on_audio(&sample),
                _ => {}
            }
        }
    }

    pub struct Recorder {
        stream: SCStream,
        sink: Arc<Sink>,
        path: PathBuf,
    }

    fn init_cg() {
        // Without this, the first ScreenCaptureKit call from a non-main
        // thread can abort with CGS_REQUIRE_INIT (see the crate's examples).
        static INIT: Once = Once::new();
        extern "C" {
            fn sc_initialize_core_graphics();
        }
        INIT.call_once(|| unsafe { sc_initialize_core_graphics() });
    }

    pub fn list_windows() -> Result<Vec<CaptureWindow>, String> {
        init_cg();
        let content = SCShareableContent::get().map_err(|e| format!("{e:?}"))?;
        let ContentSnapshot { applications, windows, .. } =
            content.snapshot().ok_or("could not snapshot shareable content")?;
        Ok(windows
            .iter()
            .filter(|w| w.frame.size.width > 100.0 && w.frame.size.height > 100.0)
            .map(|w| CaptureWindow {
                window_id: w.window_id,
                app_name: w
                    .owning_app_index
                    .and_then(|i| applications.get(i))
                    .map(|a| a.application_name.clone())
                    .unwrap_or_default(),
                title: w.title.clone().unwrap_or_default(),
                width: w.frame.size.width,
                height: w.frame.size.height,
                on_screen: w.is_on_screen,
            })
            .collect())
    }

    impl Recorder {
        /// Starts recording the largest on-screen window whose
        /// "app - title" contains `query` (case-insensitive).
        pub fn start(query: &str, path: &Path) -> Result<Self, String> {
            init_cg();
            let q = query.to_lowercase();
            let target = list_windows()?
                .into_iter()
                .filter(|w| w.on_screen)
                .filter(|w| format!("{} - {}", w.app_name, w.title).to_lowercase().contains(&q))
                .max_by(|a, b| (a.width * a.height).total_cmp(&(b.width * b.height)))
                .ok_or_else(|| format!("no on-screen window matches {query:?}"))?;

            let content = SCShareableContent::get().map_err(|e| format!("{e:?}"))?;
            let window = content
                .windows()
                .into_iter()
                .find(|w| w.window_id() == target.window_id)
                .ok_or("window closed before capture started")?;
            let filter = SCContentFilter::create()
                .with_window(&window)
                .build()
                .map_err(|e| format!("{e:?}"))?;

            // Points → pixels at 2x, capped, even dimensions for H.264.
            let scale = (MAX_WIDTH / target.width).min(2.0);
            let w = ((target.width * scale) as u32) & !1;
            let h = ((target.height * scale) as u32) & !1;
            let config = SCStreamConfiguration::new()
                .with_width(w)
                .with_height(h)
                .with_fps(FPS)
                // The encoder's native input; BGRA would cost a conversion.
                .with_pixel_format(PixelFormat::YCbCr_420v)
                .with_shows_cursor(true)
                .with_captures_audio(true);

            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let _ = std::fs::remove_file(path);
            let writer = Writer::create(path, FileType::Mp4).map_err(|e| format!("{e:?}"))?;
            // Keys are the string values of AVFoundation's AVVideo*/AV*Key
            // constants; the bridge passes the dictionary through untouched.
            let video_settings = serde_json::json!({
                "AVVideoCodecKey": "avc1",
                "AVVideoWidthKey": w,
                "AVVideoHeightKey": h,
                "AVVideoCompressionPropertiesKey": {
                    "AverageBitRate": VIDEO_BITRATE,
                    "ExpectedFrameRate": FPS,
                    "MaxKeyFrameIntervalDuration": KEYFRAME_SECS,
                    "ProfileLevel": "H264_High_AutoLevel",
                    "AllowFrameReordering": false,
                },
            });
            let audio_settings = serde_json::json!({
                "AVFormatIDKey": 1_633_772_320u32, // kAudioFormatMPEG4AAC ('aac ')
                "AVSampleRateKey": 48_000,
                "AVNumberOfChannelsKey": 2,
                "AVEncoderBitRateKey": AUDIO_BITRATE,
            });
            let video = writer
                .add_input(&MediaType::Video, Some(&video_settings), None, true)
                .map_err(|e| format!("video input: {e:?}"))?;
            let audio = writer
                .add_input(&MediaType::Audio, Some(&audio_settings), None, true)
                .map_err(|e| format!("audio input: {e:?}"))?;

            let sink = Arc::new(Sink {
                writer: Mutex::new(Some(writer)),
                video,
                audio,
                first: Mutex::new(None),
                first_at: Mutex::new(None),
                last_secs: Mutex::new(0.0),
                frames: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
            });
            let mut stream = SCStream::new(&filter, &config).map_err(|e| format!("{e:?}"))?;
            stream
                .add_output_handler(Handler(sink.clone()), SCStreamOutputType::Screen)
                .map_err(|e| format!("{e:?}"))?;
            stream
                .add_output_handler(Handler(sink.clone()), SCStreamOutputType::Audio)
                .map_err(|e| format!("{e:?}"))?;
            stream.start_capture().map_err(|e| format!("{e:?}"))?;
            log::info!(
                "recording {} - {} ({}x{} @{FPS}, {} Mbps) to {}",
                target.app_name,
                target.title,
                w,
                h,
                VIDEO_BITRATE / 1_000_000,
                path.display()
            );
            Ok(Self { stream, sink, path: path.to_path_buf() })
        }

        /// Wall-clock time of video time zero, once the first frame arrived.
        pub fn video_epoch(&self) -> Option<std::time::Instant> {
            *self.sink.first_at.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Stops capture and waits for the movie to be finalised.
        pub fn stop(self) -> Result<RecordingResult, String> {
            let _ = self.stream.stop_capture();
            let writer = self
                .sink
                .writer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .ok_or("recording already stopped")?;
            let frames = self.sink.frames.load(Ordering::Relaxed);
            let dropped = self.sink.dropped.load(Ordering::Relaxed);
            if frames == 0 {
                let _ = writer.cancel();
                return Err("no frames were captured".into());
            }
            writer.finish().map_err(|e| format!("{e:?}"))?;
            let duration_secs = *self.sink.last_secs.lock().unwrap_or_else(|e| e.into_inner());
            log::info!("recording: {frames} frames written, {dropped} dropped by the encoder");
            let bytes = std::fs::metadata(&self.path).map(|m| m.len() as i64).unwrap_or(0);
            Ok(RecordingResult { path: self.path, bytes, duration_secs })
        }
    }

    #[cfg(test)]
    mod capture_tests {
        use super::*;

        /// `RECORD_QUERY="Finder" cargo test recorder -- --ignored --nocapture`
        #[test]
        #[ignore]
        fn records_a_window() {
            let query = std::env::var("RECORD_QUERY").unwrap_or_else(|_| "Finder".into());
            for w in list_windows().unwrap().iter().filter(|w| w.on_screen) {
                println!("{} - {} ({}x{})", w.app_name, w.title, w.width, w.height);
            }
            let path = std::env::temp_dir().join("querylol-recorder-test.mp4");
            let rec = Recorder::start(&query, &path).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(5));
            let r = rec.stop().unwrap();
            println!("{r:?}");
            assert!(r.bytes > 0);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{CaptureWindow, RecordingResult};
    use std::path::Path;

    pub struct Recorder;

    pub fn list_windows() -> Result<Vec<CaptureWindow>, String> {
        Err("recording is only implemented on macOS".into())
    }

    impl Recorder {
        pub fn start(_query: &str, _path: &Path) -> Result<Self, String> {
            Err("recording is only implemented on macOS".into())
        }
        pub fn stop(self) -> Result<RecordingResult, String> {
            Err("recording is only implemented on macOS".into())
        }
        pub fn video_epoch(&self) -> Option<std::time::Instant> {
            None
        }
    }
}

pub use imp::{list_windows, Recorder};

/// Whether this platform can record. The UI hides the setting elsewhere.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

/// What the recording is of, filled in from live and post-game data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GameInfo {
    pub game_id: i64,
    pub champion_id: i64,
    pub queue: String,
    pub win: Option<bool>,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub moments: Vec<KeyMoment>,
    pub gold_timeline: Vec<GoldDiffPoint>,
}

/// The `{id}.json` written next to each `{id}.mp4`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RecordingMeta {
    /// Unix seconds when recording started.
    pub created_at: i64,
    pub duration_secs: f64,
    pub bytes: i64,
    /// `video_t = game_t + offset_secs`; `None` if no game time was seen.
    pub offset_secs: Option<f64>,
    /// Chosen by the user: never pruned and not counted toward `KEEP_RECENT`.
    pub kept: bool,
    #[serde(flatten)]
    pub game: GameInfo,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingEntry {
    /// File stem, the handle the UI passes back to keep or delete.
    pub id: String,
    pub path: PathBuf,
    #[serde(flatten)]
    pub meta: RecordingMeta,
}

/// A game being recorded.
pub struct Session {
    recorder: Recorder,
    created_at: i64,
    offset_secs: Option<f64>,
}

#[derive(Default)]
pub struct RecorderState {
    pub session: Option<Session>,
}

pub type SharedRecorder = std::sync::Arc<std::sync::Mutex<RecorderState>>;

pub fn recordings_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("recordings")
}

/// Called every in-game poll. Starts recording once the game window exists,
/// then fixes the clock offset from the first poll that reports a game time.
/// `clock` is that poll's game time and the instant it returned, so the
/// offset does not depend on how stale the poll is by now.
pub fn tick(rec: &SharedRecorder, app: &tauri::AppHandle, clock: Option<(f64, std::time::Instant)>) {
    let mut st = rec.lock().unwrap_or_else(|e| e.into_inner());
    if st.session.is_none() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let path = recordings_dir(app).join(format!("game-{stamp}.mp4"));
        match Recorder::start(DEFAULT_WINDOW_QUERY, &path) {
            Ok(recorder) => st.session = Some(Session { recorder, created_at: stamp, offset_secs: None }),
            // The game window appears a few seconds after InProgress.
            Err(e) => log::debug!("recording not started yet: {e}"),
        }
    }
    let Some(s) = st.session.as_mut() else { return };
    let (Some((game_time, polled_at)), Some(epoch)) = (clock, s.recorder.video_epoch()) else { return };
    if s.offset_secs.is_none() && game_time > 0.0 {
        let video_t = if polled_at >= epoch {
            (polled_at - epoch).as_secs_f64()
        } else {
            -(epoch - polled_at).as_secs_f64()
        };
        s.offset_secs = Some(video_t - game_time);
        log::info!("recording offset: video = game + {:.2}s", video_t - game_time);
    }
}

pub fn is_recording(rec: &SharedRecorder) -> bool {
    rec.lock().map(|r| r.session.is_some()).unwrap_or(false)
}

/// Stops the current recording, names it after the game when there is one
/// (Practice Tool games keep their timestamp name), writes its metadata and
/// prunes old recordings.
pub fn finish(rec: &SharedRecorder, game: GameInfo) -> Option<RecordingResult> {
    let session = rec.lock().unwrap_or_else(|e| e.into_inner()).session.take()?;
    let mut result = match session.recorder.stop() {
        Ok(r) => r,
        Err(e) => {
            log::error!("stopping recording failed: {e}");
            return None;
        }
    };
    if game.game_id > 0 {
        let final_path = result.path.with_file_name(format!("{}.mp4", game.game_id));
        if std::fs::rename(&result.path, &final_path).is_ok() {
            result.path = final_path;
        }
    }
    let meta = RecordingMeta {
        created_at: session.created_at,
        duration_secs: result.duration_secs,
        bytes: result.bytes,
        offset_secs: session.offset_secs,
        kept: false,
        game,
    };
    write_meta(&result.path, &meta);
    log::info!("recording saved: {result:?}, {} moments", meta.game.moments.len());
    if let Some(dir) = result.path.parent() {
        prune(dir, KEEP_RECENT);
    }
    Some(result)
}

fn read_meta(video: &Path) -> Option<RecordingMeta> {
    let text = std::fs::read_to_string(video.with_extension("json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(video: &Path, meta: &RecordingMeta) {
    if let Ok(text) = serde_json::to_string(meta) {
        let _ = std::fs::write(video.with_extension("json"), text);
    }
}

fn videos(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "mp4"))
                .collect()
        })
        .unwrap_or_default()
}

/// All recordings, newest first.
pub fn list(dir: &Path) -> Vec<RecordingEntry> {
    let mut out: Vec<RecordingEntry> = videos(dir)
        .into_iter()
        .map(|path| {
            let mut meta = read_meta(&path).unwrap_or_default();
            let mtime = || {
                std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            };
            if meta.created_at == 0 {
                meta.created_at = mtime();
            }
            if meta.bytes == 0 {
                meta.bytes = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
            }
            let id = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            RecordingEntry { id, path, meta }
        })
        .collect();
    out.sort_by(|a, b| b.meta.created_at.cmp(&a.meta.created_at));
    out
}

/// Resolves a recording id from the UI to its video, refusing anything that
/// could escape the recordings folder.
fn video_for(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let valid = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("invalid recording id {id:?}"));
    }
    let video = dir.join(format!("{id}.mp4"));
    if video.exists() { Ok(video) } else { Err(format!("recording {id} not found")) }
}

pub fn set_kept(dir: &Path, id: &str, kept: bool) -> Result<(), String> {
    let video = video_for(dir, id)?;
    let mut meta = read_meta(&video).unwrap_or_default();
    meta.kept = kept;
    write_meta(&video, &meta);
    Ok(())
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let video = video_for(dir, id)?;
    std::fs::remove_file(&video).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(video.with_extension("json"));
    Ok(())
}

/// Recordings kept besides the ones the user chose to keep. At ~1.6 GB per
/// 35-minute game this caps the folder near 16 GB.
pub const KEEP_RECENT: usize = 10;

/// Deletes the oldest recordings beyond `keep`, never touching one whose
/// metadata says `"kept": true`; kept recordings do not count toward `keep`.
pub fn prune(dir: &Path, keep: usize) {
    let mut recent: Vec<RecordingEntry> = list(dir).into_iter().filter(|r| !r.meta.kept).collect();
    recent.sort_by(|a, b| b.meta.created_at.cmp(&a.meta.created_at));
    for r in recent.into_iter().skip(keep) {
        log::info!("recording: pruning {}", r.path.display());
        let _ = std::fs::remove_file(&r.path);
        let _ = std::fs::remove_file(r.path.with_extension("json"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_recent_and_kept() {
        let dir = std::env::temp_dir().join(format!("querylol-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 0 is the oldest; 1 is kept by the user.
        for i in 0..5 {
            let video = dir.join(format!("{i}.mp4"));
            std::fs::write(&video, b"x").unwrap();
            let kept = i == 1;
            std::fs::write(
                video.with_extension("json"),
                format!(r#"{{"kept":{kept},"created_at":{}}}"#, 1_000 + i),
            )
            .unwrap();
        }
        prune(&dir, 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["1.json", "1.mp4", "3.json", "3.mp4", "4.json", "4.mp4"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
