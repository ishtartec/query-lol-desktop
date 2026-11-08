//! Cuts a clip out of a recording without re-encoding: reads the sample
//! tables of the source MP4 (plain `stbl` samples and/or movie fragments)
//! and writes the chosen samples into a new, plain MP4 whose timeline starts
//! at zero. Platform-independent, so macOS and Windows share it.
//!
//! The source is whatever the recorders leave behind:
//! - macOS `AVAssetWriter` with a fragment interval writes the first
//!   interval as ordinary `stbl` samples in `moov`, then one `mdat` + `moof`
//!   pair per interval (the `moof` *after* its data, `base_data_offset`
//!   absolute, no `tfdt`, several `trun`s per `traf`). `finishWriting`
//!   rewrites a completed file as a plain movie, so only interrupted
//!   recordings stay fragmented.
//! - Windows Media Foundation's FMPEG4 container: empty `stbl`, every sample
//!   in `moof`/`mdat` pairs; plain MP4 when that container is refused.
//!
//! Video can only start on a keyframe, so the clip starts at the last
//! keyframe at or before the requested start (recordings have one every
//! 2 s). Audio is cut to that same instant through the edit list, which also
//! carries over the AAC priming offset the source declares.
//!
//! The `mp4` crate (0.14) was evaluated and rejected: for fragmented files it
//! takes every sample's offset from `tfhd.base_data_offset` alone (ignoring
//! `trun.data_offset` and earlier samples), guesses sync samples, reads only
//! one `trun` per `traf` and drops the `stbl` samples that precede the
//! fragments. Its writer also rebuilds `avcC`/`esds` from a few fields
//! instead of copying them, so the sample descriptions are copied verbatim
//! here instead.

use serde::Serialize;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// What was written, in source video time.
#[derive(Debug, Clone, Serialize)]
pub struct ClipResult {
    pub path: PathBuf,
    /// Where the clip really starts: the keyframe at or before the request.
    pub start_secs: f64,
    pub end_secs: f64,
    pub duration_secs: f64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    offset: u64,
    size: u32,
    /// Decode time, in the track's media timescale.
    dts: i64,
    duration: u32,
    /// Composition offset (pts - dts).
    cto: i32,
    sync: bool,
    /// 1-based index into the track's `stsd`.
    desc: u32,
}

#[derive(Debug, Default)]
struct Track {
    id: u32,
    handler: [u8; 4],
    timescale: u32,
    language: [u8; 2],
    /// Boxes copied as they are (whole box, header included).
    tkhd: Vec<u8>,
    hdlr: Vec<u8>,
    media_header: Vec<u8>, // vmhd / smhd / nmhd
    dinf: Vec<u8>,
    stsd: Vec<u8>,
    /// Source edit list, reduced to what maps media time to movie time:
    /// empty edits up front (a delay, seconds) and the first media time.
    delay_secs: f64,
    media_time: i64,
    /// trex defaults: description index, duration, size, flags.
    trex: (u32, u32, u32, u32),
    samples: Vec<Sample>,
}

impl Track {
    /// Movie-timeline seconds of a media time (what `<video>.currentTime`
    /// shows).
    fn secs(&self, media_t: i64) -> f64 {
        (media_t - self.media_time) as f64 / f64::from(self.timescale.max(1)) + self.delay_secs
    }
    fn pts_secs(&self, s: &Sample) -> f64 {
        self.secs(s.dts + i64::from(s.cto))
    }
}

// ---------- reading ----------

fn be_u16(b: &[u8], o: usize) -> Result<u16, String> {
    b.get(o..o + 2).map(|x| u16::from_be_bytes([x[0], x[1]])).ok_or_else(truncated)
}
fn be_u32(b: &[u8], o: usize) -> Result<u32, String> {
    b.get(o..o + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]])).ok_or_else(truncated)
}
fn be_u64(b: &[u8], o: usize) -> Result<u64, String> {
    b.get(o..o + 8).map(|x| u64::from_be_bytes(x.try_into().unwrap())).ok_or_else(truncated)
}
fn truncated() -> String {
    "the recording's index is damaged".into()
}

/// One box inside a buffer: type, whole box (header included), payload.
struct BoxRef<'a> {
    kind: [u8; 4],
    whole: &'a [u8],
    body: &'a [u8],
}

/// Children of a container payload. Stops quietly at a malformed tail.
fn children(buf: &[u8]) -> Vec<BoxRef<'_>> {
    let mut out = Vec::new();
    let mut o = 0usize;
    while o + 8 <= buf.len() {
        let size32 = u32::from_be_bytes(buf[o..o + 4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = buf[o + 4..o + 8].try_into().unwrap();
        let (size, header) = match size32 {
            0 => ((buf.len() - o) as u64, 8),
            1 => match be_u64(buf, o + 8) {
                Ok(s) => (s, 16),
                Err(_) => break,
            },
            s => (s, 8),
        };
        if size < header as u64 || o as u64 + size > buf.len() as u64 {
            break;
        }
        let end = o + size as usize;
        out.push(BoxRef { kind, whole: &buf[o..end], body: &buf[o + header..end] });
        o = end;
    }
    out
}

fn child<'a>(buf: &'a [u8], kind: &[u8; 4]) -> Option<BoxRef<'a>> {
    children(buf).into_iter().find(|b| &b.kind == kind)
}

/// Top-level boxes of the file: (type, payload offset, payload size).
/// A box running past the end of the file (an interrupted write) ends the
/// list.
fn top_level(file: &mut File, len: u64) -> Result<Vec<([u8; 4], u64, u64)>, String> {
    let mut out = Vec::new();
    let mut o = 0u64;
    while o + 8 <= len {
        file.seek(SeekFrom::Start(o)).map_err(|e| e.to_string())?;
        let mut h = [0u8; 16];
        let n = if o + 16 <= len { 16 } else { 8 };
        file.read_exact(&mut h[..n]).map_err(|e| e.to_string())?;
        let size32 = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = h[4..8].try_into().unwrap();
        let (size, header) = match size32 {
            0 => (len - o, 8),
            1 if n == 16 => (u64::from_be_bytes(h[8..16].try_into().unwrap()), 16),
            1 => break,
            s => (s, 8),
        };
        if size < header || o + size > len {
            break;
        }
        out.push((kind, o + header, size - header));
        o += size;
    }
    Ok(out)
}

fn read_at(file: &mut File, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; usize::try_from(len).map_err(|_| truncated())?];
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Full-box version and flags.
fn ver_flags(b: &[u8]) -> Result<(u8, u32), String> {
    let v = be_u32(b, 0)?;
    Ok(((v >> 24) as u8, v & 0x00ff_ffff))
}

fn parse_trak(trak: &[u8], movie_timescale: u32) -> Result<Track, String> {
    let mut t = Track::default();
    let tkhd = child(trak, b"tkhd").ok_or_else(truncated)?;
    let (v, _) = ver_flags(tkhd.body)?;
    t.id = be_u32(tkhd.body, if v == 1 { 20 } else { 12 })?;
    t.tkhd = tkhd.whole.to_vec();

    let mdia = child(trak, b"mdia").ok_or_else(truncated)?;
    let mdhd = child(mdia.body, b"mdhd").ok_or_else(truncated)?;
    let (v, _) = ver_flags(mdhd.body)?;
    let (ts_at, lang_at) = if v == 1 { (20, 32) } else { (12, 20) };
    t.timescale = be_u32(mdhd.body, ts_at)?;
    t.language = be_u16(mdhd.body, lang_at)?.to_be_bytes();
    let hdlr = child(mdia.body, b"hdlr").ok_or_else(truncated)?;
    t.handler = hdlr.body.get(8..12).ok_or_else(truncated)?.try_into().unwrap();
    t.hdlr = hdlr.whole.to_vec();

    let minf = child(mdia.body, b"minf").ok_or_else(truncated)?;
    for b in children(minf.body) {
        match &b.kind {
            b"vmhd" | b"smhd" | b"nmhd" | b"sthd" => t.media_header = b.whole.to_vec(),
            b"dinf" => t.dinf = b.whole.to_vec(),
            _ => {}
        }
    }
    let stbl = child(minf.body, b"stbl").ok_or_else(truncated)?;
    t.stsd = child(stbl.body, b"stsd").ok_or_else(truncated)?.whole.to_vec();

    if let Some(elst) = child(trak, b"edts").and_then(|e| child(e.body, b"elst")) {
        let (v, _) = ver_flags(elst.body)?;
        let n = be_u32(elst.body, 4)? as usize;
        let mut delay: u64 = 0;
        for i in 0..n {
            let (dur, mt) = if v == 1 {
                let o = 8 + i * 20;
                (be_u64(elst.body, o)?, be_u64(elst.body, o + 8)? as i64)
            } else {
                let o = 8 + i * 12;
                (u64::from(be_u32(elst.body, o)?), i64::from(be_u32(elst.body, o + 4)? as i32))
            };
            if mt == -1 {
                delay += dur;
            } else {
                t.media_time = mt;
                break;
            }
        }
        t.delay_secs = delay as f64 / f64::from(movie_timescale.max(1));
    }

    t.samples = parse_stbl(stbl.body)?;
    Ok(t)
}

/// Expands the classic sample tables.
fn parse_stbl(stbl: &[u8]) -> Result<Vec<Sample>, String> {
    let Some(stsz) = child(stbl, b"stsz") else { return Ok(Vec::new()) };
    let fixed = be_u32(stsz.body, 4)?;
    let count = be_u32(stsz.body, 8)? as usize;
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut samples = Vec::with_capacity(count);
    for i in 0..count {
        let size = if fixed != 0 { fixed } else { be_u32(stsz.body, 12 + i * 4)? };
        samples.push(Sample { offset: 0, size, dts: 0, duration: 0, cto: 0, sync: true, desc: 1 });
    }

    // Decode times.
    let stts = child(stbl, b"stts").ok_or_else(truncated)?;
    let (mut i, mut dts) = (0usize, 0i64);
    for e in 0..be_u32(stts.body, 4)? as usize {
        let n = be_u32(stts.body, 8 + e * 8)?;
        let d = be_u32(stts.body, 12 + e * 8)?;
        for _ in 0..n {
            if let Some(s) = samples.get_mut(i) {
                s.dts = dts;
                s.duration = d;
            }
            dts += i64::from(d);
            i += 1;
        }
    }
    if let Some(ctts) = child(stbl, b"ctts") {
        let mut i = 0usize;
        for e in 0..be_u32(ctts.body, 4)? as usize {
            let n = be_u32(ctts.body, 8 + e * 8)?;
            let off = be_u32(ctts.body, 12 + e * 8)? as i32;
            for _ in 0..n {
                if let Some(s) = samples.get_mut(i) {
                    s.cto = off;
                }
                i += 1;
            }
        }
    }
    if let Some(stss) = child(stbl, b"stss") {
        samples.iter_mut().for_each(|s| s.sync = false);
        for e in 0..be_u32(stss.body, 4)? as usize {
            let n = be_u32(stss.body, 8 + e * 4)? as usize;
            if let Some(s) = n.checked_sub(1).and_then(|i| samples.get_mut(i)) {
                s.sync = true;
            }
        }
    }

    // Offsets: chunks from stco/co64, samples per chunk from stsc.
    let chunks: Vec<u64> = if let Some(stco) = child(stbl, b"stco") {
        (0..be_u32(stco.body, 4)? as usize).map(|i| be_u32(stco.body, 8 + i * 4).map(u64::from)).collect::<Result<_, _>>()?
    } else if let Some(co64) = child(stbl, b"co64") {
        (0..be_u32(co64.body, 4)? as usize).map(|i| be_u64(co64.body, 8 + i * 8)).collect::<Result<_, _>>()?
    } else {
        return Err(truncated());
    };
    let stsc = child(stbl, b"stsc").ok_or_else(truncated)?;
    let runs: Vec<(u32, u32, u32)> = (0..be_u32(stsc.body, 4)? as usize)
        .map(|e| Ok((be_u32(stsc.body, 8 + e * 12)?, be_u32(stsc.body, 12 + e * 12)?, be_u32(stsc.body, 16 + e * 12)?)))
        .collect::<Result<_, String>>()?;
    let mut i = 0usize;
    for (ci, &chunk_offset) in chunks.iter().enumerate() {
        let chunk_no = ci as u32 + 1;
        let Some(&(_, per_chunk, desc)) = runs.iter().rev().find(|r| r.0 <= chunk_no) else { break };
        let mut o = chunk_offset;
        for _ in 0..per_chunk {
            let Some(s) = samples.get_mut(i) else { break };
            s.offset = o;
            s.desc = desc;
            o += u64::from(s.size);
            i += 1;
        }
    }
    samples.truncate(i);
    Ok(samples)
}

/// Appends the samples of one `moof` to the tracks.
fn parse_moof(moof: &[u8], moof_start: u64, tracks: &mut [Track]) -> Result<(), String> {
    let mut prev_traf_end: Option<u64> = None;
    for traf in children(moof).into_iter().filter(|b| &b.kind == b"traf") {
        let tfhd = child(traf.body, b"tfhd").ok_or_else(truncated)?;
        let (_, f) = ver_flags(tfhd.body)?;
        let id = be_u32(tfhd.body, 4)?;
        let Some(track) = tracks.iter_mut().find(|t| t.id == id) else { continue };
        let (mut desc, mut dur, mut size, mut flags) = track.trex;
        let mut o = 8;
        let mut base = if f & 0x02_0000 != 0 { moof_start } else { prev_traf_end.unwrap_or(moof_start) };
        if f & 0x01 != 0 {
            base = be_u64(tfhd.body, o)?;
            o += 8;
        }
        if f & 0x02 != 0 {
            desc = be_u32(tfhd.body, o)?;
            o += 4;
        }
        if f & 0x08 != 0 {
            dur = be_u32(tfhd.body, o)?;
            o += 4;
        }
        if f & 0x10 != 0 {
            size = be_u32(tfhd.body, o)?;
            o += 4;
        }
        if f & 0x20 != 0 {
            flags = be_u32(tfhd.body, o)?;
        }

        // Without tfdt, decoding continues where the track left off.
        let mut dts = match child(traf.body, b"tfdt") {
            Some(tfdt) => match ver_flags(tfdt.body)?.0 {
                1 => be_u64(tfdt.body, 4)? as i64,
                _ => i64::from(be_u32(tfdt.body, 4)?),
            },
            None => track.samples.last().map(|s| s.dts + i64::from(s.duration)).unwrap_or(0),
        };
        let mut pos = base;
        for trun in children(traf.body).into_iter().filter(|b| &b.kind == b"trun") {
            let b = trun.body;
            let (v, tf) = ver_flags(b)?;
            let n = be_u32(b, 4)? as usize;
            let mut o = 8;
            if tf & 0x01 != 0 {
                pos = base.wrapping_add_signed(i64::from(be_u32(b, o)? as i32));
                o += 4;
            }
            let mut first_flags = None;
            if tf & 0x04 != 0 {
                first_flags = Some(be_u32(b, o)?);
                o += 4;
            }
            for i in 0..n {
                let mut s_dur = dur;
                let mut s_size = size;
                let mut s_flags = if i == 0 { first_flags.unwrap_or(flags) } else { flags };
                let mut cto = 0i32;
                if tf & 0x100 != 0 {
                    s_dur = be_u32(b, o)?;
                    o += 4;
                }
                if tf & 0x200 != 0 {
                    s_size = be_u32(b, o)?;
                    o += 4;
                }
                if tf & 0x400 != 0 {
                    s_flags = be_u32(b, o)?;
                    o += 4;
                }
                if tf & 0x800 != 0 {
                    let raw = be_u32(b, o)?;
                    cto = if v == 0 { i32::try_from(raw).unwrap_or(i32::MAX) } else { raw as i32 };
                    o += 4;
                }
                track.samples.push(Sample {
                    offset: pos,
                    size: s_size,
                    dts,
                    duration: s_dur,
                    cto,
                    sync: s_flags & 0x0001_0000 == 0,
                    desc,
                });
                pos += u64::from(s_size);
                dts += i64::from(s_dur);
            }
        }
        prev_traf_end = Some(pos);
    }
    Ok(())
}

/// Every track of the file with its full sample list.
fn read_movie(file: &mut File) -> Result<Vec<Track>, String> {
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let boxes = top_level(file, len)?;
    let &(_, moov_at, moov_len) = boxes.iter().find(|b| &b.0 == b"moov").ok_or("the recording has no index (moov)")?;
    let moov = read_at(file, moov_at, moov_len)?;
    let mvhd = child(&moov, b"mvhd").ok_or_else(truncated)?;
    let movie_timescale = be_u32(mvhd.body, if ver_flags(mvhd.body)?.0 == 1 { 20 } else { 12 })?;

    let mut tracks = Vec::new();
    for trak in children(&moov).into_iter().filter(|b| &b.kind == b"trak") {
        tracks.push(parse_trak(trak.body, movie_timescale)?);
    }
    if let Some(mvex) = child(&moov, b"mvex") {
        for trex in children(mvex.body).into_iter().filter(|b| &b.kind == b"trex") {
            let id = be_u32(trex.body, 4)?;
            if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
                t.trex = (be_u32(trex.body, 8)?, be_u32(trex.body, 12)?, be_u32(trex.body, 16)?, be_u32(trex.body, 20)?);
            }
        }
    }
    for &(kind, at, size) in &boxes {
        if &kind == b"moof" {
            let moof = read_at(file, at, size)?;
            // The header precedes the payload by 8 bytes (moofs never use
            // a 64-bit size in practice; `top_level` would have read it).
            parse_moof(&moof, at - 8, &mut tracks)?;
        }
    }
    // An interrupted write can index data that never reached the disk.
    for t in &mut tracks {
        if let Some(bad) = t.samples.iter().position(|s| s.offset + u64::from(s.size) > len) {
            t.samples.truncate(bad);
        }
    }
    Ok(tracks)
}

// ---------- cutting ----------

/// Samples of one output track: the source slice plus the edit that makes
/// it start at the clip's zero.
struct Cut<'a> {
    track: &'a Track,
    samples: &'a [Sample],
    /// Media time (output, first sample at 0) shown when the track starts.
    media_time: i64,
    /// Clip time at which the track starts: audio that began after the
    /// clip's first keyframe (only at the very start of a recording).
    delay_secs: f64,
    /// Clip-timeline length of the track, seconds.
    duration_secs: f64,
}

/// The decode-order range of samples presented in [from, to).
fn plan(tracks: &[Track], start: f64, end: f64) -> Result<(Vec<Cut<'_>>, f64, f64), String> {
    let video = tracks
        .iter()
        .find(|t| &t.handler == b"vide" && !t.samples.is_empty())
        .ok_or("the recording has no video")?;
    let vs = &video.samples;
    let last_pts = vs.iter().map(|s| video.pts_secs(s)).fold(f64::MIN, f64::max);
    if start >= last_pts {
        return Err("the clip starts after the recording ends".into());
    }
    let first = vs
        .iter()
        .rposition(|s| s.sync && video.pts_secs(s) <= start + 0.001)
        .or_else(|| vs.iter().position(|s| s.sync))
        .ok_or("the recording has no keyframes")?;
    let clip_start = video.pts_secs(&vs[first]);
    let last = first + vs[first..].iter().position(|s| video.pts_secs(s) >= end).unwrap_or(vs.len() - first);
    if last <= first {
        return Err("the clip is empty".into());
    }
    let v_slice = &vs[first..last];
    let v_end = v_slice
        .iter()
        .map(|s| video.pts_secs(s) + f64::from(s.duration) / f64::from(video.timescale))
        .fold(f64::MIN, f64::max)
        .min(end);
    let clip_end = v_end;
    let mut cuts = vec![Cut {
        track: video,
        samples: v_slice,
        media_time: i64::from(v_slice[0].cto),
        delay_secs: 0.0,
        duration_secs: clip_end - clip_start,
    }];

    for t in tracks.iter().filter(|t| &t.handler == b"soun") {
        let ts = f64::from(t.timescale.max(1));
        let a = t.samples.iter().position(|s| t.pts_secs(s) + f64::from(s.duration) / ts > clip_start);
        let Some(a) = a else { continue };
        let b = a + t.samples[a..].iter().position(|s| t.pts_secs(s) >= clip_end).unwrap_or(t.samples.len() - a);
        if b <= a {
            continue;
        }
        let slice = &t.samples[a..b];
        let a_start = t.pts_secs(&slice[0]);
        let lead = ((clip_start - a_start) * ts).round().max(0.0) as i64;
        let a_end = t.pts_secs(&slice[slice.len() - 1]) + f64::from(slice[slice.len() - 1].duration) / ts;
        cuts.push(Cut {
            track: t,
            samples: slice,
            media_time: i64::from(slice[0].cto) + lead,
            delay_secs: (a_start - clip_start).max(0.0),
            duration_secs: a_end.min(clip_end) - a_start.max(clip_start),
        });
    }
    Ok((cuts, clip_start, clip_end))
}

// ---------- writing ----------

const MOVIE_TIMESCALE: u32 = 1000;
/// Longest run of one track's samples stored together; keeps audio and
/// video close in the file so players don't seek back and forth.
const CHUNK_SECS: f64 = 0.5;

fn put_box(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(8 + body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
}

fn full_box(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(body.len() + 4);
    b.extend_from_slice(&((u32::from(version) << 24) | flags).to_be_bytes());
    b.extend_from_slice(body);
    let mut out = Vec::new();
    put_box(&mut out, kind, &b);
    out
}

fn container(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let body: Vec<u8> = parts.concat();
    let mut out = Vec::new();
    put_box(&mut out, kind, &body);
    out
}

/// One output chunk: a run of consecutive samples of one track.
struct Chunk {
    cut: usize,
    first: usize,
    count: usize,
    offset: u64,
}

/// Interleaves the cuts in time order, CHUNK_SECS at a time.
fn chunks(cuts: &[Cut]) -> Vec<Chunk> {
    let mut next = vec![0usize; cuts.len()];
    let mut out: Vec<Chunk> = Vec::new();
    loop {
        // The track whose next sample decodes earliest.
        let pick = (0..cuts.len())
            .filter(|&c| next[c] < cuts[c].samples.len())
            .min_by(|&a, &b| {
                let ta = cuts[a].track.secs(cuts[a].samples[next[a]].dts);
                let tb = cuts[b].track.secs(cuts[b].samples[next[b]].dts);
                ta.total_cmp(&tb)
            });
        let Some(c) = pick else { break };
        let cut = &cuts[c];
        let first = next[c];
        let t0 = cut.track.secs(cut.samples[first].dts);
        let desc = cut.samples[first].desc;
        let mut n = 0;
        while first + n < cut.samples.len() {
            let s = &cut.samples[first + n];
            if s.desc != desc || cut.track.secs(s.dts) - t0 >= CHUNK_SECS {
                break;
            }
            n += 1;
        }
        next[c] += n;
        out.push(Chunk { cut: c, first, count: n, offset: 0 });
    }
    out
}

fn secs_to(ts: u32, secs: f64) -> u64 {
    (secs.max(0.0) * f64::from(ts)).round() as u64
}

/// Copies a tkhd, setting its duration and the enabled/in-movie flags.
fn patch_tkhd(tkhd: &[u8], duration: u64) -> Vec<u8> {
    let mut b = tkhd.to_vec();
    if b.len() < 12 {
        return b;
    }
    let header = if u32::from_be_bytes(b[0..4].try_into().unwrap()) == 1 { 16 } else { 8 };
    let v = b[header];
    b[header + 3] |= 0x03;
    if v == 1 {
        if let Some(d) = b.get_mut(header + 28..header + 36) {
            d.copy_from_slice(&duration.to_be_bytes());
        }
    } else if let Some(d) = b.get_mut(header + 20..header + 24) {
        d.copy_from_slice(&(duration.min(u64::from(u32::MAX)) as u32).to_be_bytes());
    }
    b
}

fn build_trak(cut: &Cut, chunks: &[Chunk], cut_index: usize) -> Vec<u8> {
    let t = cut.track;
    let s = cut.samples;
    let media_duration: u64 = s.iter().map(|x| u64::from(x.duration)).sum();
    let movie_duration = secs_to(MOVIE_TIMESCALE, cut.duration_secs);

    let mut stts = Vec::new();
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for x in s {
        match runs.last_mut() {
            Some((n, d)) if *d == x.duration => *n += 1,
            _ => runs.push((1, x.duration)),
        }
    }
    stts.extend_from_slice(&(runs.len() as u32).to_be_bytes());
    runs.iter().for_each(|(n, d)| {
        stts.extend_from_slice(&n.to_be_bytes());
        stts.extend_from_slice(&d.to_be_bytes());
    });

    let ctts = s.iter().any(|x| x.cto != 0).then(|| {
        let mut runs: Vec<(u32, i32)> = Vec::new();
        for x in s {
            match runs.last_mut() {
                Some((n, c)) if *c == x.cto => *n += 1,
                _ => runs.push((1, x.cto)),
            }
        }
        let mut b = (runs.len() as u32).to_be_bytes().to_vec();
        runs.iter().for_each(|(n, c)| {
            b.extend_from_slice(&n.to_be_bytes());
            b.extend_from_slice(&c.to_be_bytes());
        });
        // Version 1 allows negative offsets.
        full_box(b"ctts", u8::from(runs.iter().any(|r| r.1 < 0)), 0, &b)
    });

    let stss = s.iter().any(|x| !x.sync).then(|| {
        let keys: Vec<u32> = s.iter().enumerate().filter(|(_, x)| x.sync).map(|(i, _)| i as u32 + 1).collect();
        let mut b = (keys.len() as u32).to_be_bytes().to_vec();
        keys.iter().for_each(|k| b.extend_from_slice(&k.to_be_bytes()));
        full_box(b"stss", 0, 0, &b)
    });

    let mut stsz = 0u32.to_be_bytes().to_vec();
    stsz.extend_from_slice(&(s.len() as u32).to_be_bytes());
    s.iter().for_each(|x| stsz.extend_from_slice(&x.size.to_be_bytes()));

    let mine: Vec<&Chunk> = chunks.iter().filter(|c| c.cut == cut_index).collect();
    let mut stsc_runs: Vec<(u32, u32, u32)> = Vec::new();
    for (i, c) in mine.iter().enumerate() {
        let desc = s[c.first].desc;
        if stsc_runs.last().map(|r| (r.1, r.2)) != Some((c.count as u32, desc)) {
            stsc_runs.push((i as u32 + 1, c.count as u32, desc));
        }
    }
    let mut stsc = (stsc_runs.len() as u32).to_be_bytes().to_vec();
    stsc_runs.iter().for_each(|(a, b, c)| {
        stsc.extend_from_slice(&a.to_be_bytes());
        stsc.extend_from_slice(&b.to_be_bytes());
        stsc.extend_from_slice(&c.to_be_bytes());
    });
    let mut co64 = (mine.len() as u32).to_be_bytes().to_vec();
    mine.iter().for_each(|c| co64.extend_from_slice(&c.offset.to_be_bytes()));

    let mut stbl_parts: Vec<Vec<u8>> = vec![t.stsd.clone(), full_box(b"stts", 0, 0, &stts)];
    stbl_parts.extend(ctts);
    stbl_parts.extend(stss);
    stbl_parts.push(full_box(b"stsz", 0, 0, &stsz));
    stbl_parts.push(full_box(b"stsc", 0, 0, &stsc));
    stbl_parts.push(full_box(b"co64", 0, 0, &co64));
    let stbl = container(b"stbl", &stbl_parts.iter().map(|p| p.as_slice()).collect::<Vec<_>>());
    let minf = container(b"minf", &[&t.media_header, &t.dinf, &stbl]);

    let mut mdhd = Vec::new();
    mdhd.extend_from_slice(&[0u8; 8]); // creation, modification
    mdhd.extend_from_slice(&t.timescale.to_be_bytes());
    mdhd.extend_from_slice(&(media_duration.min(u64::from(u32::MAX)) as u32).to_be_bytes());
    mdhd.extend_from_slice(&t.language);
    mdhd.extend_from_slice(&[0, 0]);
    let mdia = container(b"mdia", &[&full_box(b"mdhd", 0, 0, &mdhd), &t.hdlr, &minf]);

    // Show the clip from `media_time`, so every track starts at 0; an empty
    // edit first when the track starts later than the clip.
    let delay = secs_to(MOVIE_TIMESCALE, cut.delay_secs);
    let mut elst = (1 + u32::from(delay > 0)).to_be_bytes().to_vec();
    if delay > 0 {
        elst.extend_from_slice(&(delay as u32).to_be_bytes());
        elst.extend_from_slice(&(-1i32).to_be_bytes());
        elst.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    }
    elst.extend_from_slice(&(movie_duration as u32).to_be_bytes());
    elst.extend_from_slice(&(cut.media_time as u32).to_be_bytes());
    elst.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    let edts = container(b"edts", &[&full_box(b"elst", 0, 0, &elst)]);

    container(b"trak", &[&patch_tkhd(&t.tkhd, delay + movie_duration), &edts, &mdia])
}

fn build_moov(cuts: &[Cut], chunks: &[Chunk]) -> Vec<u8> {
    let duration = cuts
        .iter()
        .map(|c| secs_to(MOVIE_TIMESCALE, c.delay_secs) + secs_to(MOVIE_TIMESCALE, c.duration_secs))
        .max()
        .unwrap_or(0);
    let next_id = cuts.iter().map(|c| c.track.id).max().unwrap_or(0) + 1;
    let mut mvhd = Vec::new();
    mvhd.extend_from_slice(&[0u8; 8]);
    mvhd.extend_from_slice(&MOVIE_TIMESCALE.to_be_bytes());
    mvhd.extend_from_slice(&(duration as u32).to_be_bytes());
    mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    mvhd.extend_from_slice(&[0u8; 10]);
    for m in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        mvhd.extend_from_slice(&m.to_be_bytes());
    }
    mvhd.extend_from_slice(&[0u8; 24]);
    mvhd.extend_from_slice(&next_id.to_be_bytes());
    let mut parts = vec![full_box(b"mvhd", 0, 0, &mvhd)];
    for (i, c) in cuts.iter().enumerate() {
        parts.push(build_trak(c, chunks, i));
    }
    container(b"moov", &parts.iter().map(|p| p.as_slice()).collect::<Vec<_>>())
}

fn write_clip(file: &mut File, cuts: &[Cut], dst: &Path) -> Result<u64, String> {
    let mut ftyp = Vec::new();
    put_box(&mut ftyp, b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41");

    let mut chunks = chunks(cuts);
    let data_len: u64 = chunks
        .iter()
        .map(|c| cuts[c.cut].samples[c.first..c.first + c.count].iter().map(|s| u64::from(s.size)).sum::<u64>())
        .sum();
    let mdat_header: u64 = if data_len + 8 > u64::from(u32::MAX) { 16 } else { 8 };
    // co64 entries have a fixed size, so the moov's length does not depend
    // on the offsets: build once to measure, again with the real offsets.
    let moov_len = build_moov(cuts, &chunks).len() as u64;
    let mut o = ftyp.len() as u64 + moov_len + mdat_header;
    for c in &mut chunks {
        c.offset = o;
        o += cuts[c.cut].samples[c.first..c.first + c.count].iter().map(|s| u64::from(s.size)).sum::<u64>();
    }
    let moov = build_moov(cuts, &chunks);

    let out = File::create(dst).map_err(|e| format!("couldn't create the clip: {e}"))?;
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let io = |e: std::io::Error| format!("couldn't write the clip: {e}");
    w.write_all(&ftyp).map_err(io)?;
    w.write_all(&moov).map_err(io)?;
    if mdat_header == 16 {
        w.write_all(&1u32.to_be_bytes()).map_err(io)?;
        w.write_all(b"mdat").map_err(io)?;
        w.write_all(&(data_len + 16).to_be_bytes()).map_err(io)?;
    } else {
        w.write_all(&((data_len + 8) as u32).to_be_bytes()).map_err(io)?;
        w.write_all(b"mdat").map_err(io)?;
    }
    let mut buf = Vec::new();
    for c in &chunks {
        for s in &cuts[c.cut].samples[c.first..c.first + c.count] {
            buf.resize(s.size as usize, 0);
            file.seek(SeekFrom::Start(s.offset)).map_err(|e| e.to_string())?;
            file.read_exact(&mut buf).map_err(|e| format!("couldn't read the recording: {e}"))?;
            w.write_all(&buf).map_err(io)?;
        }
    }
    w.flush().map_err(io)?;
    Ok(ftyp.len() as u64 + moov.len() as u64 + mdat_header + data_len)
}

/// Writes [start, end) of `src` (video seconds) to `dst`. The clip starts at
/// the keyframe at or before `start`; `ClipResult` says where that was.
/// Writes to a temporary name first so a failure never leaves a broken file.
pub fn export(src: &Path, dst: &Path, start: f64, end: f64) -> Result<ClipResult, String> {
    if start.is_nan() || end.is_nan() || end <= start {
        return Err("the clip's end must come after its start".into());
    }
    let mut file = File::open(src).map_err(|e| format!("couldn't open the recording: {e}"))?;
    let tracks = read_movie(&mut file)?;
    let (cuts, clip_start, clip_end) = plan(&tracks, start.max(0.0), end)?;
    let part = dst.with_extension("mp4.part");
    let bytes = match write_clip(&mut file, &cuts, &part) {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    };
    std::fs::rename(&part, dst).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("couldn't save the clip: {e}")
    })?;
    Ok(ClipResult {
        path: dst.to_path_buf(),
        start_secs: clip_start,
        end_secs: clip_end,
        duration_secs: clip_end - clip_start,
        bytes,
    })
}

/// A file name in `dir` that does not exist yet: `stem.mp4`, `stem 2.mp4`…
pub fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.mp4"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem} {n}.mp4")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cuts a real file: `CLIP_SRC=in.mp4 CLIP_DST=out.mp4 CLIP_RANGE=12.3,24
    /// cargo test --lib clip::tests::cut_file -- --nocapture`. Skipped
    /// without CLIP_SRC.
    #[test]
    fn cut_file() {
        let Ok(src) = std::env::var("CLIP_SRC") else { return };
        let dst = std::env::var("CLIP_DST").unwrap_or_else(|_| "clip.mp4".into());
        let range = std::env::var("CLIP_RANGE").unwrap_or_else(|_| "12.3,24".into());
        let (a, b) = range.split_once(',').unwrap();
        let r = export(Path::new(&src), Path::new(&dst), a.parse().unwrap(), b.parse().unwrap()).unwrap();
        println!("{r:?}");
    }

    #[test]
    fn unique_path_counts_up() {
        let dir = std::env::temp_dir().join(format!("querylol-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "clip");
        std::fs::write(&a, b"x").unwrap();
        let b = unique_path(&dir, "clip");
        assert_eq!(b.file_name().unwrap(), "clip 2.mp4");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
