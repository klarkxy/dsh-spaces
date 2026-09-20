#!/usr/bin/env node
// Assemble recorded workbench footage with pre-generated narration. No recording, mmx, or product mutations.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".sandbox/workbench-demo-delivery");
const edit = join(root, ".sandbox/workbench-demo-edit");
const bin = process.env.DEMO_FFMPEG_DIR || join(root, ".sandbox/spaces-demo-tools/ffmpeg/ffmpeg-9.0.1-essentials_build/bin");
const footage = join(root, ".sandbox/workbench-demo-video");
const audioRoot = join(root, ".sandbox/workbench-demo-audio");
const narrationPath = join(root, "tasks/workbench-demo-narration.json");
const fontSrc = "C:/Windows/Fonts/msyh.ttc";
const captions = [];
const assembled = [];
let offset = 0;

function run(exe, args, logName) {
  const p = spawnSync(join(bin, exe), args, {
    cwd: edit,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (logName) writeFileSync(join(edit, logName), `${p.stdout || ""}${p.stderr || ""}`);
  if (p.error || p.status !== 0) throw new Error(`${exe}: ${p.error?.message || (p.stderr || "").slice(-3000)}`);
  return p.stdout;
}

function probe(path) {
  return JSON.parse(run("ffprobe.exe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]));
}

function seconds(s) {
  const [h, m, v] = s.replace(",", ".").split(":").map(Number);
  return h * 3600 + m * 60 + v;
}

function time(s, ass = false) {
  const n = Math.round(s * (ass ? 100 : 1000));
  const unit = ass ? 100 : 1000;
  const hh = Math.floor(n / (unit * 3600));
  const mm = Math.floor(n / (unit * 60)) % 60;
  const ss = Math.floor(n / unit) % 60;
  return `${ass ? hh : String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${ass ? "." : ","}${String(n % unit).padStart(ass ? 2 : 3, "0")}`;
}

function readableCues(path) {
  const blocks = readFileSync(path, "utf8").trim().split(/\r?\n\s*\r?\n/);
  return blocks.flatMap((block) => {
    const lines = block.trim().split(/\r?\n/);
    const [a, b] = lines[1].split(" --> ").map(seconds);
    const text = lines.slice(2).join("");
    const phrases = text.match(/[^，。！？；]+[，。！？；]?/g) || [text];
    const chunks = [];
    for (const phrase of phrases) {
      for (let p = 0; p < phrase.length; p += 36) {
        const part = phrase.slice(p, p + 36);
        if (chunks.length && chunks.at(-1).length + part.length <= 36) chunks[chunks.length - 1] += part;
        else chunks.push(part);
      }
    }
    const weight = chunks.reduce((n, x) => n + x.length, 0);
    let used = 0;
    return chunks.map((piece) => {
      const start = a + ((b - a) * used) / weight;
      used += piece.length;
      return { start: start + 0.5, end: a + ((b - a) * used) / weight + 0.5, text: piece };
    });
  });
}

function ass(cues) {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,34,&H00FFFFFF,&H00FFFFFF,&H00182030,&H00182030,0,0,0,0,100,100,0,0,1,1.5,0,2,70,70,28,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    cues.map((c) => `Dialogue: 0,${time(c.start, true)},${time(c.end, true)},Default,,0,0,0,,${c.text.replace(/[{}]/g, "")}`).join("\n") +
    "\n";
}

function keepWindows(start, end, omits = []) {
  const cuts = (omits || [])
    .map((row) => ({ start: Math.max(start, row.startSec), end: Math.min(end, row.endSec) }))
    .filter((row) => row.end - row.start > 0.2)
    .sort((a, b) => a.start - b.start);
  const windows = [];
  let cursor = start;
  for (const cut of cuts) {
    if (cut.start > cursor + 0.05) windows.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (end > cursor + 0.05) windows.push({ start: cursor, end });
  if (!windows.length) throw new Error("omitRanges removed the whole chapter");
  return windows;
}

function cutVideo(videoPath, windows, rawName) {
  if (windows.length === 1) {
    run(
      "ffmpeg.exe",
      ["-hide_banner", "-y", "-ss", String(windows[0].start), "-t", String(windows[0].end - windows[0].start), "-i", videoPath, "-an", "-c:v", "libvpx", "-crf", "10", "-b:v", "0", rawName],
      `${rawName}.cut.log`,
    );
    return rawName;
  }
  const parts = [];
  for (let i = 0; i < windows.length; i++) {
    const name = rawName.replace(/\.webm$/, `-${i}.webm`);
    run(
      "ffmpeg.exe",
      ["-hide_banner", "-y", "-ss", String(windows[i].start), "-t", String(windows[i].end - windows[i].start), "-i", videoPath, "-an", "-c:v", "libvpx", "-crf", "10", "-b:v", "0", name],
      `${name}.cut.log`,
    );
    parts.push(name);
  }
  writeFileSync(join(edit, `${rawName}.concat.txt`), parts.map((name) => `file '${name}'`).join("\n") + "\n");
  run(
    "ffmpeg.exe",
    ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", `${rawName}.concat.txt`, "-c", "copy", rawName],
    `${rawName}.join.log`,
  );
  return rawName;
}

function previewHtml(rows, duration) {
  const buttons = rows
    .map((row) => `<button data-time="${row.start}">${time(row.start).slice(3, 8)} ${row.title}</button>`)
    .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH Spaces 工作台介绍</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0c1424;color:#edf3fb;font-family:system-ui,"Microsoft YaHei",sans-serif}main{max-width:1280px;margin:auto;padding:30px 24px}h1{font-size:26px;margin:0 0 8px}p{color:#a9bbcf}video{display:block;width:100%;background:#000;border-radius:10px;margin:24px 0}nav{display:flex;flex-wrap:wrap;gap:10px}button,a{font:inherit;color:inherit;border:1px solid #314359;border-radius:6px;padding:10px 14px;background:#18263a;cursor:pointer;text-decoration:none}footer{margin:24px 0;display:flex;gap:10px}</style><main><h1>DSH Spaces 工作台介绍</h1><p>真实工作台操作录像 · MiniMax 合成配音 · ${duration.toFixed(1)} 秒 · 可按章节查看</p><video controls playsinline preload="metadata" src="DSH-Spaces-workbench.mp4"></video><nav>${buttons}</nav><footer><a href="DSH-Spaces-workbench.mp4" download>保存视频</a><a href="DSH-Spaces-zh.srt" download>中文字幕</a><a href="DSH-Spaces-narration.mp3" download>独立配音</a></footer></main><script>const v=document.querySelector('video');document.querySelectorAll('button[data-time]').forEach(b=>b.onclick=()=>{v.currentTime=Number(b.dataset.time);v.play()});</script></html>`;
}

function main() {
  if (!existsSync(join(bin, "ffmpeg.exe")) || !existsSync(join(bin, "ffprobe.exe"))) {
    throw new Error(`FFmpeg missing under ${bin}`);
  }
  if (!existsSync(fontSrc)) throw new Error(`font missing: ${fontSrc}`);
  const sourcePath = join(footage, "results.json");
  if (!existsSync(sourcePath)) {
    throw new Error("missing .sandbox/workbench-demo-video/results.json; record-workbench-demo.mjs has not been run");
  }
  mkdirSync(edit, { recursive: true });
  mkdirSync(output, { recursive: true });
  copyFileSync(fontSrc, join(edit, "font.ttc"));
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const narration = JSON.parse(readFileSync(narrationPath, "utf8"));
  if (narration.length !== 4) throw new Error("need 4 narration chapters");
  if (source.status !== "recorded") throw new Error(`footage status is ${source.status}, need recorded`);
  if (source.unrecorded?.length) throw new Error(`unrecorded chapters: ${source.unrecorded.join(",")}`);
  if (!Array.isArray(source.chapters) || source.chapters.length !== 4) {
    throw new Error(`need exactly 4 recorded chapters, got ${source.chapters?.length ?? 0}`);
  }
  writeFileSync(join(edit, "credit.txt"), "DSH Spaces · 工作台实录 · MiniMax 合成配音");
  for (let i = 0; i < narration.length; i++) {
    const chapter = source.chapters[i];
    const speech = narration[i];
    if (chapter.id !== speech.id) throw new Error(`chapter id mismatch ${chapter.id} vs ${speech.id}`);
    if (chapter.status !== "recorded") throw new Error(`Unaccepted chapter ${chapter.id}: ${chapter.status}`);
    const id = String(i + 1).padStart(2, "0");
    const audioPath = join(audioRoot, `${speech.id}.mp3`);
    const videoPath = chapter.video.path;
    if (!existsSync(videoPath) || !existsSync(audioPath)) throw new Error(`Missing media for ${chapter.id}`);
    const videoSeconds = Number(probe(videoPath).format.duration);
    const audioSeconds = Number(probe(audioPath).format.duration);
    const start = chapter.trimStartSec;
    const end = Math.min(chapter.trimEndSec, videoSeconds - 0.12);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`Invalid trim: ${chapter.id}`);
    const windows = keepWindows(start, end, chapter.omitRanges);
    const cues = readableCues(join(audioRoot, `${speech.id}.srt`));
    writeFileSync(join(edit, `${id}.ass`), ass(cues));
    writeFileSync(join(edit, `${id}-title.txt`), `${id} / ${speech.title}`);
    let inputArgs = [];
    let rawDuration;
    if (windows.length === 1) {
      rawDuration = windows[0].end - windows[0].start;
      inputArgs = ["-ss", String(windows[0].start), "-t", String(rawDuration), "-i", videoPath, "-i", audioPath];
    } else {
      const rawName = `${id}-cut.webm`;
      cutVideo(videoPath, windows, rawName);
      rawDuration = Number(probe(join(edit, rawName)).format.duration);
      inputArgs = ["-i", rawName, "-i", audioPath];
    }
    const duration = Math.max(rawDuration, audioSeconds + 1.5); // never shrink footage to the audio length
    const stretch = Math.min(1.6, duration / rawDuration);
    const filter = `setpts=${stretch}*(PTS-STARTPTS),fps=25,scale=1664:936:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:128:64:color=0x0c1424,setsar=1,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},drawtext=fontfile=font.ttc:textfile=${id}-title.txt:fontcolor=white:fontsize=27:x=128:y=19,drawtext=fontfile=font.ttc:textfile=credit.txt:fontcolor=0x9eb0c6:fontsize=18:x=w-tw-128:y=23,ass=${id}.ass`;
    run(
      "ffmpeg.exe",
      [
        "-hide_banner",
        "-y",
        ...inputArgs,
        "-filter_complex",
        `[0:v]${filter}[v];[1:a]adelay=500:all=1,volume=2dB,apad,atrim=duration=${duration}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "19",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        String(duration),
        "-movflags",
        "+faststart",
        `${id}.mp4`,
      ],
      `${id}-render.log`,
    );
    const actualDuration = Number(probe(join(edit, `${id}.mp4`)).format.duration);
    captions.push(...cues.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset })));
    assembled.push({
      id,
      title: speech.title,
      source: videoPath,
      sourceSha256: chapter.video?.sha256 || null,
      sourceDurationSec: videoSeconds,
      audioPath,
      audioDurationSec: audioSeconds,
      trimStart: start,
      trimEnd: end,
      omitRanges: chapter.omitRanges || [],
      stretch,
      start: offset,
      duration: actualDuration,
    });
    offset += actualDuration;
    console.log(`Rendered ${id}: ${actualDuration.toFixed(2)} seconds`);
  }
  writeFileSync(join(edit, "concat.txt"), assembled.map((c) => `file '${c.id}.mp4'`).join("\n") + "\n");
  const final = join(output, "DSH-Spaces-workbench.mp4");
  run(
    "ffmpeg.exe",
    [
      "-hide_banner",
      "-y",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-metadata",
      "comment=Real DSH workbench recording; synthetic narration generated with MiniMax via local mmx-cli",
      final,
    ],
    "concat.log",
  );
  writeFileSync(
    join(output, "DSH-Spaces-zh.srt"),
    captions.map((c, i) => `${i + 1}\n${time(c.start)} --> ${time(c.end)}\n${c.text}\n`).join("\n"),
  );
  run("ffmpeg.exe", ["-hide_banner", "-y", "-i", final, "-vn", "-c:a", "libmp3lame", "-q:a", "2", join(output, "DSH-Spaces-narration.mp3")], "audio-export.log");
  const validation = probe(final);
  writeFileSync(
    join(output, "edit-manifest.json"),
    JSON.stringify(
      {
        chapters: assembled,
        duration: offset,
        final,
        footageRoot: footage,
        audioRoot,
        narration: {
          path: narrationPath,
          kind: "synthetic",
          provider: "MiniMax",
          via: "mmx-cli (pre-generated by root; this script does not call mmx)",
        },
        subtitleTiming: "MiniMax coarse timings, proportionally split into readable short cues",
        video: {
          width: 1920,
          height: 1080,
          codec: "h264",
          audioCodec: "aac",
        },
        validation,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(output, "index.html"), previewHtml(assembled, offset));
  console.log(final);
}

if (import.meta.main) main();

export { output, edit, footage };
