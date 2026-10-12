//! Windows recorder: Windows.Graphics.Capture grabs the game window, the
//! D3D11 video processor scales it and converts it to NV12 on the GPU, and a
//! Media Foundation sink writer encodes H.264 + AAC into a fragmented MP4.
//! Audio is the game process only (WASAPI process loopback), falling back to
//! everything the default device plays.
//!
//! Written against the `windows` version Tauri already pulls in rather than
//! the `windows-capture` crate: its encoder has no keyframe interval, writes a
//! plain MP4 (unplayable after a crash), crops a larger window instead of
//! scaling it and queues frames without bound.

use super::{CaptureWindow, RecordingResult};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};
use windows::core::{Interface, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoIncrementMTAUsage;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
};

/// Same output as the macOS recorder, so files cost the same on both.
const MAX_WIDTH: u32 = 1920;
const FPS: u32 = 60;
const VIDEO_BITRATE: u32 = 6_000_000;
/// The Media Foundation AAC encoder only takes 12000/16000/20000/24000
/// bytes per second; 16000 is 128 kbps.
const AUDIO_BYTES_PER_SEC: u32 = 16_000;
const KEYFRAME_SECS: u32 = 2;
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
const BLOCK_ALIGN: u32 = CHANNELS * 2;
/// 100 ns units, Media Foundation's clock.
const HNS: i64 = 10_000_000;
const FRAME_HNS: i64 = HNS / FPS as i64;
/// NV12 surfaces handed to the encoder. A slot is reused only once the
/// encoder has consumed it; a frame arriving while all are busy is dropped.
const RING: usize = 8;
/// Silence longer than this between audio packets is filled with zeros so
/// audio stays aligned with video (loopback sends nothing during silence).
const AUDIO_GAP_HNS: i64 = 200_000;

fn err(e: windows::core::Error) -> String {
    format!("{} (0x{:08X})", e.message(), e.code().0)
}

/// Lets Win32 COM pointers that are free-threaded (sink writer, D3D11 device
/// with multithread protection) cross threads; windows-rs does not mark them.
struct Unsafe<T>(T);
unsafe impl<T> Send for Unsafe<T> {}
unsafe impl<T> Sync for Unsafe<T> {}
impl<T> Unsafe<T> {
    /// Through a method so closures capture the wrapper, not the field.
    fn get(&self) -> &T {
        &self.0
    }
}

fn init_com() {
    // Puts every thread that never initialised COM in the process MTA, so
    // the poll loop, the capture callback and the audio thread can share the
    // free-threaded objects below.
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe {
        let _ = CoIncrementMTAUsage();
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            log::error!("recording: MFStartup failed: {}", err(e));
        }
    });
}

/// QueryPerformanceCounter in 100 ns units: the clock that capture frame
/// timestamps (`SystemRelativeTime`) and WASAPI's QPC positions use.
fn qpc_hns() -> i64 {
    let (mut c, mut f) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    if f == 0 {
        return 0;
    }
    (c as i128 * HNS as i128 / f as i128) as i64
}

pub fn has_permission() -> bool {
    // Windows has no screen-capture consent for desktop apps.
    true
}

pub fn request_permission() {}

/// Length of a movie on disk, for recordings that lost their metadata.
pub fn media_duration(path: &Path) -> Option<f64> {
    init_com();
    unsafe {
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), None).ok()?;
        let v = reader
            .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .ok()?;
        let hns = v.Anonymous.Anonymous.Anonymous.uhVal;
        (hns > 0).then(|| hns as f64 / HNS as f64)
    }
}

struct Found {
    hwnd: HWND,
    window: CaptureWindow,
}

fn enum_windows() -> Vec<Found> {
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> windows::core::BOOL {
        let out = unsafe { &mut *(lp.0 as *mut Vec<Found>) };
        let mut buf = [0u16; 256];
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if n > 0 {
            let mut r = RECT::default();
            let _ = unsafe { GetClientRect(hwnd, &mut r) };
            let (w, h) = ((r.right - r.left) as f64, (r.bottom - r.top) as f64);
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            out.push(Found {
                hwnd,
                window: CaptureWindow {
                    window_id: hwnd.0 as usize as u32,
                    app_name: format!("pid {pid}"),
                    title: String::from_utf16_lossy(&buf[..n as usize]),
                    width: w,
                    height: h,
                    on_screen: unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() },
                },
            });
        }
        true.into()
    }
    let mut out: Vec<Found> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

pub fn list_windows() -> Result<Vec<CaptureWindow>, String> {
    Ok(enum_windows()
        .into_iter()
        .map(|f| f.window)
        .filter(|w| w.width > 100.0 && w.height > 100.0)
        .collect())
}

/// Scales `src` into `dst` keeping its aspect ratio, centred.
fn letterbox(src: (u32, u32), dst: (u32, u32)) -> RECT {
    let s = (dst.0 as f64 / src.0.max(1) as f64).min(dst.1 as f64 / src.1.max(1) as f64);
    let (w, h) = ((src.0 as f64 * s) as i32, (src.1 as f64 * s) as i32);
    let (x, y) = ((dst.0 as i32 - w) / 2, (dst.1 as i32 - h) / 2);
    RECT { left: x, top: y, right: x + w, bottom: y + h }
}

/// GPU scaler/converter for one input texture size. Rebuilt when the game
/// window changes size (League resizes when switching display modes).
struct Converter {
    input_size: (u32, u32),
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    outputs: Vec<ID3D11VideoProcessorOutputView>,
}

struct Video {
    vdevice: ID3D11VideoDevice,
    vcontext: ID3D11VideoContext,
    out_size: (u32, u32),
    ring: Vec<ID3D11Texture2D>,
    converter: Option<Converter>,
}

impl Video {
    fn converter(&mut self, input_size: (u32, u32)) -> windows::core::Result<&Converter> {
        if self.converter.as_ref().map(|c| c.input_size) != Some(input_size) {
            self.converter = None;
            let rate = DXGI_RATIONAL { Numerator: FPS, Denominator: 1 };
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: input_size.0,
                InputHeight: input_size.1,
                OutputFrameRate: rate,
                OutputWidth: self.out_size.0,
                OutputHeight: self.out_size.1,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            unsafe {
                let enumerator = self.vdevice.CreateVideoProcessorEnumerator(&desc)?;
                let processor = self.vdevice.CreateVideoProcessor(&enumerator, 0)?;
                // RGB full range in, BT.709 limited range out: what players assume.
                let out_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: (1 << 2) | (1 << 4) };
                self.vcontext.VideoProcessorSetOutputColorSpace(&processor, &out_cs);
                let in_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 };
                self.vcontext.VideoProcessorSetStreamColorSpace(&processor, 0, &in_cs);
                self.vcontext.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
                self.vcontext.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
                let black = D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 0.0625, Cb: 0.5, Cr: 0.5, A: 1.0 } } };
                self.vcontext.VideoProcessorSetOutputBackgroundColor(&processor, true, &black);
                let mut outputs = Vec::with_capacity(RING);
                for tex in &self.ring {
                    let vd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
                    };
                    let mut view = None;
                    self.vdevice.CreateVideoProcessorOutputView(tex, &enumerator, &vd, Some(&mut view))?;
                    outputs.push(view.unwrap());
                }
                self.converter = Some(Converter { input_size, enumerator, processor, outputs });
            }
        }
        Ok(self.converter.as_ref().unwrap())
    }

    /// Scales `src` (the capture frame) into ring slot `slot` as NV12.
    fn convert(&mut self, src: &ID3D11Texture2D, content: (u32, u32), slot: usize) -> windows::core::Result<()> {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        unsafe { src.GetDesc(&mut d) };
        let out_size = self.out_size;
        let (vdevice, vcontext) = (self.vdevice.clone(), self.vcontext.clone());
        let conv = self.converter((d.Width, d.Height))?;
        let content = (content.0.min(d.Width), content.1.min(d.Height));
        unsafe {
            let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input = None;
            vdevice.CreateVideoProcessorInputView(src, &conv.enumerator, &ivd, Some(&mut input))?;
            let source = RECT { left: 0, top: 0, right: content.0 as i32, bottom: content.1 as i32 };
            vcontext.VideoProcessorSetStreamSourceRect(&conv.processor, 0, true, Some(&source));
            let dest = letterbox(content, out_size);
            vcontext.VideoProcessorSetStreamDestRect(&conv.processor, 0, true, Some(&dest));
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(input),
                ..Default::default()
            };
            let mut streams = [stream];
            let r = vcontext.VideoProcessorBlt(&conv.processor, &conv.outputs[slot], 0, &streams);
            std::mem::ManuallyDrop::drop(&mut streams[0].pInputSurface);
            r
        }
    }
}

/// Shared by the capture callback, the audio thread and `stop`.
struct Sink {
    writer: Mutex<Option<Unsafe<IMFSinkWriter>>>,
    video_stream: u32,
    audio_stream: Option<u32>,
    video: Mutex<Unsafe<Video>>,
    /// QPC time (100 ns) of the first frame: video time zero.
    first_hns: Mutex<Option<i64>>,
    first_at: Mutex<Option<Instant>>,
    last_hns: Mutex<i64>,
    /// Next audio sample time, relative to `first_hns`.
    audio_next: Mutex<i64>,
    frames: AtomicU64,
    dropped: AtomicU64,
    failure: Mutex<Option<String>>,
}

impl Sink {
    fn fail(&self, msg: String) {
        let mut f = self.failure.lock().unwrap_or_else(|e| e.into_inner());
        if f.is_none() {
            log::error!("recording: writer failed: {msg}");
            *f = Some(msg);
        }
    }

    fn on_frame(&self, pool: &Direct3D11CaptureFramePool, device: &IDirect3DDevice, size: &Mutex<SizeInt32>) {
        let Ok(frame) = pool.TryGetNextFrame() else { return };
        let (Ok(content), Ok(ts)) = (frame.ContentSize(), frame.SystemRelativeTime()) else { return };
        {
            // The window changed size: resize the pool, skip this frame.
            let mut s = size.lock().unwrap_or_else(|e| e.into_inner());
            if content.Width != s.Width || content.Height != s.Height {
                *s = content;
                let _ = pool.Recreate(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
                return;
            }
        }
        let guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let Some(writer) = guard.as_ref() else { return };
        let ts = ts.Duration;
        let t = {
            let mut first = self.first_hns.lock().unwrap_or_else(|e| e.into_inner());
            let f = *first.get_or_insert_with(|| {
                // Wall-clock instant of the frame, not of this callback.
                let late = Duration::from_nanos(((qpc_hns() - ts).max(0) * 100) as u64);
                *self.first_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() - late);
                ts
            });
            ts - f
        };
        let mut last = self.last_hns.lock().unwrap_or_else(|e| e.into_inner());
        // Older Windows ignores MinUpdateInterval: cap at FPS ourselves.
        if self.frames.load(Ordering::Relaxed) > 0 && t - *last < FRAME_HNS * 9 / 10 {
            return;
        }
        // Back-pressure: every ring slot still held by the encoder. Counted
        // against encoded, not processed, samples: the fragmented sink holds
        // encoded samples until a fragment closes, long after the encoder
        // has let go of the surface.
        let mut st = MF_SINK_WRITER_STATISTICS { cb: std::mem::size_of::<MF_SINK_WRITER_STATISTICS>() as u32, ..Default::default() };
        if unsafe { writer.0.GetStatistics(self.video_stream, &mut st) }.is_ok()
            && st.qwNumSamplesReceived.saturating_sub(st.qwNumSamplesEncoded) >= (RING - 2) as u64
        {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let result = (|| -> windows::core::Result<()> {
            let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
            let src: ID3D11Texture2D = unsafe { access.GetInterface()? };
            let slot = self.frames.load(Ordering::Relaxed) as usize % RING;
            let mut video = self.video.lock().unwrap_or_else(|e| e.into_inner());
            video.0.convert(&src, (content.Width as u32, content.Height as u32), slot)?;
            unsafe {
                let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &video.0.ring[slot], 0, false)?;
                // Surface buffers report no length; the encoder needs one.
                if let Ok(b2) = buffer.cast::<IMF2DBuffer>() {
                    buffer.SetCurrentLength(b2.GetContiguousLength()?)?;
                }
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buffer)?;
                sample.SetSampleTime(t)?;
                sample.SetSampleDuration(FRAME_HNS)?;
                writer.0.WriteSample(self.video_stream, &sample)
            }
        })();
        match result {
            Ok(()) => {
                self.frames.fetch_add(1, Ordering::Relaxed);
                *last = t;
            }
            Err(e) => self.fail(format!("video: {}", err(e))),
        }
    }

    /// Writes PCM captured at QPC time `ts` (0 when the device gave none).
    fn on_audio(&self, pcm: &[u8], ts: u64) {
        let Some(stream) = self.audio_stream else { return };
        let Some(first) = *self.first_hns.lock().unwrap_or_else(|e| e.into_inner()) else { return };
        let guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let Some(writer) = guard.as_ref() else { return };
        let mut next = self.audio_next.lock().unwrap_or_else(|e| e.into_inner());
        let frames = (pcm.len() / BLOCK_ALIGN as usize) as i64;
        let dur = frames * HNS / SAMPLE_RATE as i64;
        let at = if ts > 0 { ts as i64 - first } else { *next };
        if at + dur <= 0 {
            return; // entirely before the first video frame
        }
        // Fill silence (and the stretch before the first packet) with zeros.
        while at - *next > AUDIO_GAP_HNS {
            let gap = (at - *next).min(HNS);
            let n = (gap * SAMPLE_RATE as i64 / HNS) as usize * BLOCK_ALIGN as usize;
            if let Err(e) = write_pcm(&writer.0, stream, &vec![0u8; n], *next) {
                return self.fail(format!("audio: {}", err(e)));
            }
            *next += (n / BLOCK_ALIGN as usize) as i64 * HNS / SAMPLE_RATE as i64;
        }
        match write_pcm(&writer.0, stream, pcm, *next) {
            Ok(()) => *next += dur,
            Err(e) => self.fail(format!("audio: {}", err(e))),
        }
    }
}

fn write_pcm(writer: &IMFSinkWriter, stream: u32, pcm: &[u8], t: i64) -> windows::core::Result<()> {
    if pcm.is_empty() {
        return Ok(());
    }
    unsafe {
        let buffer = MFCreateMemoryBuffer(pcm.len() as u32)?;
        let mut p = std::ptr::null_mut();
        buffer.Lock(&mut p, None, None)?;
        std::ptr::copy_nonoverlapping(pcm.as_ptr(), p, pcm.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(pcm.len() as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(t)?;
        sample.SetSampleDuration(pcm.len() as i64 / BLOCK_ALIGN as i64 * HNS / SAMPLE_RATE as i64)?;
        writer.WriteSample(stream, &sample)
    }
}

fn d3d_device() -> windows::core::Result<ID3D11Device> {
    let mut device = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
    }
    let device = device.unwrap();
    // The capture callback, the encoder and `stop` all touch the immediate
    // context from different threads.
    if let Ok(mt) = device.cast::<ID3D11Multithread>() {
        unsafe { let _ = mt.SetMultithreadProtected(true); }
    }
    Ok(device)
}

fn media_type(major: &windows::core::GUID, sub: &windows::core::GUID) -> windows::core::Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, major)?;
        t.SetGUID(&MF_MT_SUBTYPE, sub)?;
        Ok(t)
    }
}

fn video_type(sub: &windows::core::GUID, size: (u32, u32)) -> windows::core::Result<IMFMediaType> {
    let t = media_type(&MFMediaType_Video, sub)?;
    unsafe {
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((size.0 as u64) << 32) | size.1 as u64)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    }
    Ok(t)
}

fn audio_type(sub: &windows::core::GUID) -> windows::core::Result<IMFMediaType> {
    let t = media_type(&MFMediaType_Audio, sub)?;
    unsafe {
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
    }
    Ok(t)
}

/// Creates the sink writer. Fragmented MP4 first: if the app dies mid-game
/// the file still plays up to the last fragment, where a plain MP4 writes
/// its index only at the end.
fn sink_writer(path: &Path, manager: &IMFDXGIDeviceManager, fragmented: bool) -> windows::core::Result<IMFSinkWriter> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4)?;
        let attrs = attrs.unwrap();
        let container = if fragmented { MFTranscodeContainerType_FMPEG4 } else { MFTranscodeContainerType_MPEG4 };
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &container)?;
        attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        // Never block the capture thread; back-pressure is handled by
        // dropping frames when the ring is full.
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, manager)?;
        MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &attrs)
    }
}

/// Keyframe interval and constant bitrate, set on the encoder itself; not
/// every encoder honours `MF_MT_MAX_KEYFRAME_SPACING` on the media type.
fn tune_encoder(writer: &IMFSinkWriter, stream: u32) {
    unsafe {
        let mut p = std::ptr::null_mut();
        if writer.GetServiceForStream(stream, &windows::core::GUID::zeroed(), &ICodecAPI::IID, &mut p).is_err() || p.is_null() {
            return;
        }
        let api = ICodecAPI::from_raw(p);
        let set = |guid: &windows::core::GUID, v: u32| {
            let var = windows::Win32::System::Variant::VARIANT::from(v);
            if let Err(e) = api.SetValue(guid, &var) {
                log::warn!("recording: encoder ignored {guid:?}: {}", err(e));
            }
        };
        set(&CODECAPI_AVEncMPVGOPSize, FPS * KEYFRAME_SECS);
        set(&CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32);
        set(&CODECAPI_AVEncCommonMeanBitRate, VIDEO_BITRATE);
        set(&CODECAPI_AVEncCommonLowLatency, 1);
    }
}

/// Opens the audio source: the game's process tree when Windows supports
/// it (Windows 10 2004+), else everything on the default output device.
fn open_audio(pid: u32) -> Option<(wasapi::AudioClient, wasapi::Handle, wasapi::AudioCaptureClient)> {
    let _ = wasapi::initialize_mta();
    let format = wasapi::WaveFormat::new(16, 16, &wasapi::SampleType::Int, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let mode = wasapi::StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    let open = |mut client: wasapi::AudioClient| -> Result<_, Box<dyn std::error::Error>> {
        client.initialize_client(&format, &wasapi::Direction::Capture, &mode)?;
        let event = client.set_get_eventhandle()?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        Ok((client, event, capture))
    };
    match wasapi::AudioClient::new_application_loopback_client(pid, true).map_err(Into::into).and_then(open) {
        Ok(a) => {
            log::info!("recording: game audio from process {pid}");
            return Some(a);
        }
        Err(e) => log::warn!("recording: process loopback unavailable ({e}); recording all system audio"),
    }
    let system = (|| -> Result<_, Box<dyn std::error::Error>> {
        let device = wasapi::get_default_device(&wasapi::Direction::Render)?;
        open(device.get_iaudioclient()?)
    })();
    system.map_err(|e| log::warn!("recording: no audio: {e}")).ok()
}

fn audio_loop(sink: Arc<Sink>, stop: Arc<AtomicBool>, pid: u32) {
    let Some((client, event, capture)) = open_audio(pid) else { return };
    let mut queue: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(200).is_err() {
            continue; // silence: process loopback sends no packets
        }
        loop {
            queue.clear();
            let Ok(info) = capture.read_from_device_to_deque(&mut queue) else { break };
            if queue.is_empty() {
                break;
            }
            let ts = if info.flags.timestamp_error { 0 } else { info.timestamp };
            let pcm = queue.make_contiguous();
            if info.flags.silent {
                pcm.fill(0);
            }
            sink.on_audio(pcm, ts);
        }
    }
    let _ = client.stop_stream();
}

pub struct Recorder {
    session: Unsafe<GraphicsCaptureSession>,
    pool: Unsafe<Direct3D11CaptureFramePool>,
    sink: Arc<Sink>,
    audio_stop: Arc<AtomicBool>,
    audio: Option<std::thread::JoinHandle<()>>,
    path: PathBuf,
}

impl Recorder {
    /// Starts recording the largest visible window whose title contains
    /// `query` (case-insensitive).
    pub fn start(query: &str, path: &Path) -> Result<Self, String> {
        init_com();
        let q = query.to_lowercase();
        let target = enum_windows()
            .into_iter()
            .filter(|f| f.window.on_screen && f.window.width > 100.0 && f.window.height > 100.0)
            .filter(|f| f.window.title.to_lowercase().contains(&q))
            .max_by(|a, b| (a.window.width * a.window.height).total_cmp(&(b.window.width * b.window.height)))
            .ok_or_else(|| format!("no on-screen window matches {query:?}"))?;
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(target.hwnd, Some(&mut pid)) };

        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(path);

        let device = d3d_device().map_err(|e| format!("D3D11 device: {}", err(e)))?;
        let item: GraphicsCaptureItem = unsafe {
            windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                .and_then(|i| i.CreateForWindow(target.hwnd))
                .map_err(|e| format!("capture item: {}", err(e)))?
        };
        let size = item.Size().map_err(err)?;
        let scale = (MAX_WIDTH as f64 / size.Width.max(1) as f64).min(1.0);
        let out_size = (((size.Width as f64 * scale) as u32) & !1, ((size.Height as f64 * scale) as u32) & !1);

        let ring = (0..RING)
            .map(|_| {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: out_size.0,
                    Height: out_size.1,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                    ..Default::default()
                };
                let mut tex = None;
                unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) }.map(|_| tex.unwrap())
            })
            .collect::<windows::core::Result<Vec<_>>>()
            .map_err(|e| format!("NV12 textures: {}", err(e)))?;
        let video = Video {
            vdevice: device.cast().map_err(|e| format!("video device: {}", err(e)))?,
            vcontext: unsafe { device.GetImmediateContext() }
                .and_then(|c| c.cast())
                .map_err(|e| format!("video context: {}", err(e)))?,
            out_size,
            ring,
            converter: None,
        };

        let (writer, video_stream, audio_stream) = unsafe {
            let (mut token, mut manager) = (0u32, None);
            MFCreateDXGIDeviceManager(&mut token, &mut manager).map_err(|e| format!("device manager: {}", err(e)))?;
            let manager = manager.unwrap();
            manager.ResetDevice(&device, token).map_err(|e| format!("device manager: {}", err(e)))?;
            let writer = match sink_writer(path, &manager, true) {
                Ok(w) => w,
                Err(e) => {
                    log::warn!("recording: fragmented MP4 unavailable ({}); writing a plain MP4", err(e));
                    sink_writer(path, &manager, false).map_err(|e| format!("sink writer: {}", err(e)))?
                }
            };
            let out = video_type(&MFVideoFormat_H264, out_size).map_err(err)?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, VIDEO_BITRATE).map_err(err)?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32).map_err(err)?;
            out.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, FPS * KEYFRAME_SECS).map_err(err)?;
            let v = writer.AddStream(&out).map_err(|e| format!("video stream: {}", err(e)))?;
            let input = video_type(&MFVideoFormat_NV12, out_size).map_err(err)?;
            writer.SetInputMediaType(v, &input, None).map_err(|e| format!("video input: {}", err(e)))?;
            tune_encoder(&writer, v);

            let aac = audio_type(&MFAudioFormat_AAC).map_err(err)?;
            aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AUDIO_BYTES_PER_SEC).map_err(err)?;
            let pcm = audio_type(&MFAudioFormat_PCM).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, BLOCK_ALIGN).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, SAMPLE_RATE * BLOCK_ALIGN).map_err(err)?;
            let a = writer
                .AddStream(&aac)
                .and_then(|a| writer.SetInputMediaType(a, &pcm, None).map(|_| a))
                .map_err(|e| log::warn!("recording: no audio track: {}", err(e)))
                .ok();
            writer.BeginWriting().map_err(|e| format!("begin writing: {}", err(e)))?;
            (writer, v, a)
        };

        let sink = Arc::new(Sink {
            writer: Mutex::new(Some(Unsafe(writer))),
            video_stream,
            audio_stream,
            video: Mutex::new(Unsafe(video)),
            first_hns: Mutex::new(None),
            first_at: Mutex::new(None),
            last_hns: Mutex::new(0),
            audio_next: Mutex::new(0),
            frames: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            failure: Mutex::new(None),
        });

        let winrt_device: IDirect3DDevice = unsafe {
            CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>().map_err(err)?)
                .and_then(|i| i.cast())
                .map_err(|e| format!("WinRT device: {}", err(e)))?
        };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
            .map_err(|e| format!("frame pool: {}", err(e)))?;
        let session = pool.CreateCaptureSession(&item).map_err(|e| format!("capture session: {}", err(e)))?;
        // Each of these needs a newer Windows build; capture works without.
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetMinUpdateInterval(TimeSpan { Duration: FRAME_HNS });
        let _ = session.SetIsCursorCaptureEnabled(true);

        let (s, dev, pool_size) = (sink.clone(), Unsafe(winrt_device), Mutex::new(size));
        pool.FrameArrived(&TypedEventHandler::new(move |p: windows::core::Ref<'_, Direct3D11CaptureFramePool>, _| {
            if let Some(p) = p.as_ref() {
                s.on_frame(p, dev.get(), &pool_size);
            }
            Ok(())
        }))
        .map_err(|e| format!("frame handler: {}", err(e)))?;
        session.StartCapture().map_err(|e| format!("start capture: {}", err(e)))?;

        let audio_stop = Arc::new(AtomicBool::new(false));
        let audio = (sink.audio_stream.is_some()).then(|| {
            let (s, stop) = (sink.clone(), audio_stop.clone());
            std::thread::spawn(move || audio_loop(s, stop, pid))
        });

        log::info!(
            "recording {} ({}x{} -> {}x{} @{FPS}, {} Mbps) to {}",
            target.window.title,
            size.Width,
            size.Height,
            out_size.0,
            out_size.1,
            VIDEO_BITRATE / 1_000_000,
            path.display()
        );
        Ok(Self {
            session: Unsafe(session),
            pool: Unsafe(pool),
            sink,
            audio_stop,
            audio,
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Why the writer failed mid-recording, if it did.
    pub fn failure(&self) -> Option<String> {
        self.sink.failure.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Wall-clock time of video time zero, once the first frame arrived.
    pub fn video_epoch(&self) -> Option<Instant> {
        *self.sink.first_at.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stops capture and audio and waits for the movie to be finalised.
    pub fn stop(mut self) -> Result<RecordingResult, String> {
        let _ = self.session.0.Close();
        let _ = self.pool.0.Close();
        self.audio_stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.audio.take() {
            let _ = t.join();
        }
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
            drop(writer);
            let _ = std::fs::remove_file(&self.path);
            return Err("no frames were captured (is League in exclusive fullscreen? Borderless or Windowed works)".into());
        }
        unsafe { writer.0.Finalize() }.map_err(|e| format!("finalize: {}", err(e)))?;
        let duration_secs = *self.sink.last_hns.lock().unwrap_or_else(|e| e.into_inner()) as f64 / HNS as f64;
        log::info!("recording: {frames} frames written, {dropped} dropped by the encoder");
        let bytes = std::fs::metadata(&self.path).map(|m| m.len() as i64).unwrap_or(0);
        Ok(RecordingResult { path: self.path.clone(), bytes, duration_secs })
    }
}
