#!/usr/bin/env node
// Assemble the recorded first cut; no recording, model calls, or product mutations.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.sandbox/spaces-demo-delivery');
const edit = join(root, '.sandbox/spaces-demo-edit');
const bin = process.env.DEMO_FFMPEG_DIR || join(root, '.sandbox/spaces-demo-tools/ffmpeg/ffmpeg-9.0.1-essentials_build/bin');
const footage = join(root, '.sandbox/spaces-demo-video');
const audioRoot = join(root, '.sandbox/spaces-demo-audio');
const captions = [];
const assembled = [];
let offset = 0;

function run(exe, args, logName) {
  const p = spawnSync(join(bin, exe), args, { cwd: edit, encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  if (logName) writeFileSync(join(edit, logName), `${p.stdout || ''}${p.stderr || ''}`);
  if (p.error || p.status !== 0) throw new Error(`${exe}: ${p.error?.message || p.stderr?.slice(-3000)}`);
  return p.stdout;
}
function probe(path) {
  return JSON.parse(run('ffprobe.exe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]));
}
function seconds(s) {
  const [h, m, v] = s.replace(',', '.').split(':').map(Number);
  return h * 3600 + m * 60 + v;
}
function time(s, ass = false) {
  const n = Math.round(s * (ass ? 100 : 1000));
  const unit = ass ? 100 : 1000;
  const hh = Math.floor(n / (unit * 3600));
  const mm = Math.floor(n / (unit * 60)) % 60;
  const ss = Math.floor(n / unit) % 60;
  return `${ass ? hh : String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${ass ? '.' : ','}${String(n % unit).padStart(ass ? 2 : 3, '0')}`;
}
function readableCues(path) {
  const blocks = readFileSync(path, 'utf8').trim().split(/\r?\n\s*\r?\n/);
  return blocks.flatMap(block => {
    const lines = block.trim().split(/\r?\n/);
    const [a, b] = lines[1].split(' --> ').map(seconds);
    const text = lines.slice(2).join('');
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
    return chunks.map(text => {
      const start = a + (b - a) * used / weight;
      used += text.length;
      return { start: start + 0.5, end: a + (b - a) * used / weight + 0.5, text };
    });
  });
}
function ass(cues) {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,34,&H00FFFFFF,&H00FFFFFF,&H00182030,&H00182030,0,0,0,0,100,100,0,0,1,1.5,0,2,70,70,28,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(c => `Dialogue: 0,${time(c.start, true)},${time(c.end, true)},Default,,0,0,0,,${c.text.replace(/[{}]/g, '')}`).join('\n') + '\n';
}

function main() {
  mkdirSync(edit, { recursive: true });
  mkdirSync(output, { recursive: true });
  copyFileSync('C:/Windows/Fonts/msyh.ttc', join(edit, 'font.ttc'));
  const source = JSON.parse(readFileSync(join(footage, 'results.json'), 'utf8'));
  const narration = JSON.parse(readFileSync(join(root, 'tasks/spaces-demo-narration.json'), 'utf8'));
  if (source.chapters?.length !== narration.length) throw new Error('Expected six recorded chapters');
  for (let i = 0; i < narration.length; i++) {
    const chapter = source.chapters[i];
    const speech = narration[i];
    if (chapter.status !== 'recorded') throw new Error(`Unaccepted chapter ${chapter.id}: ${chapter.status}`);
    const id = String(i + 1).padStart(2, '0');
    const audioPath = join(audioRoot, `${speech.id}.mp3`);
    const videoPath = chapter.video.path;
    if (!existsSync(videoPath) || !existsSync(audioPath)) throw new Error(`Missing media for ${chapter.id}`);
    const videoSeconds = Number(probe(videoPath).format.duration);
    const audioSeconds = Number(probe(audioPath).format.duration);
    const start = chapter.trimStartSec;
    const end = Math.min(chapter.trimEndSec, videoSeconds - 0.12);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`Invalid trim: ${chapter.id}`);
    const rawDuration = end - start;
    const duration = Math.max(rawDuration, audioSeconds + 1.5);
    // Keep all recorded actions, modestly slow short chapters, then hold their real final frame.
    const stretch = Math.min(1.6, duration / rawDuration);
    const cues = readableCues(join(audioRoot, `${speech.id}.srt`));
    writeFileSync(join(edit, `${id}.ass`), ass(cues));
    writeFileSync(join(edit, `${id}-title.txt`), `${id} / ${speech.title}`);
    writeFileSync(join(edit, 'credit.txt'), 'DSH Spaces · 裸 Web 实录 · MiniMax 合成配音');
    const filter = `setpts=${stretch}*(PTS-STARTPTS),fps=25,scale=1664:936:flags=lanczos,pad=1920:1080:128:64:color=0x0c1424,setsar=1,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},drawtext=fontfile=font.ttc:textfile=${id}-title.txt:fontcolor=white:fontsize=27:x=128:y=19,drawtext=fontfile=font.ttc:textfile=credit.txt:fontcolor=0x9eb0c6:fontsize=18:x=w-tw-128:y=23,ass=${id}.ass`;
    run('ffmpeg.exe', ['-hide_banner', '-y', '-ss', String(start), '-t', String(rawDuration), '-i', videoPath, '-i', audioPath,
      '-filter_complex', `[0:v]${filter}[v];[1:a]adelay=500:all=1,volume=2dB,apad,atrim=duration=${duration}[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(duration), '-movflags', '+faststart', `${id}.mp4`], `${id}-render.log`);
    const actualDuration = Number(probe(join(edit, `${id}.mp4`)).format.duration);
    captions.push(...cues.map(c => ({ ...c, start: c.start + offset, end: c.end + offset })));
    assembled.push({ id, title: speech.title, source: videoPath, trimStart: start, trimEnd: end, stretch, audioPath, start: offset, duration: actualDuration });
    offset += actualDuration;
    console.log(`Rendered ${id}: ${actualDuration.toFixed(2)} seconds`);
  }
  writeFileSync(join(edit, 'concat.txt'), assembled.map(c => `file '${c.id}.mp4'`).join('\n') + '\n');
  const final = join(output, 'DSH-Spaces-first-cut.mp4');
  run('ffmpeg.exe', ['-hide_banner', '-y', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', '-metadata', 'comment=Real DSH Web recording; synthetic narration generated with MiniMax via local mmx-cli', final], 'concat.log');
  writeFileSync(join(output, 'DSH-Spaces-zh.srt'), captions.map((c, i) => `${i + 1}\n${time(c.start)} --> ${time(c.end)}\n${c.text}\n`).join('\n'));
  writeFileSync(join(output, 'edit-manifest.json'), JSON.stringify({ chapters: assembled, duration: offset, final, subtitleTiming: 'MiniMax coarse timings, proportionally split into readable short cues', validation: probe(final) }, null, 2));
  run('ffmpeg.exe', ['-hide_banner', '-y', '-i', final, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', join(output, 'DSH-Spaces-narration.mp3')], 'audio-export.log');
  console.log(final);
}

if (import.meta.main) main();
