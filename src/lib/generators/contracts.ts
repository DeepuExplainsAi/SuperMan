// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Organic Intelligence, Inc.
/**
 * The prompt contracts: what a generator task's agent is told, as run instructions (never shown as the
 * user's message). Each one fixes the output contract: the folder, the manifest the server parses, and
 * the well-known file names. Server only (imported by `server.ts`).
 */
import { GENERATOR_TAG, OUTPUT } from "./registry";
import { SLIDE_THEMES, themeById } from "./themes";
import type { GeneratorKind, GeneratorVariant } from "./types";

export interface ContractContext {
  /** Absolute task folder on the computer. */
  folder: string;
  /** Absolute path of the helper program (`om_gen.py`). */
  helper: string;
  /** Quoted native interpreter invocation when python3 is not a command (notably Windows). */
  helperCommand?: string;
  /** Native shell syntax; omitted for legacy remote computers. */
  localShell?: "powershell" | "posix";
  mediaTools?: { server: string; tool: string; kind: "image" | "video" }[];
  /** Python with the generator libraries (python-pptx, matplotlib, pandas, openpyxl, edge-tts, pypdf). */
  python: string;
  theme?: string;
  /** Absolute paths of files the user attached, already on the computer. */
  inputs: string[];
  /** What the server's ElevenLabs key offers through the omtools bridge (capped per user). */
  vendorAudio?: { speech: boolean; soundEffects: boolean; music: boolean };
}

/** Keep paths as single arguments, including spaces and apostrophes in user profiles. */
function argument(c: ContractContext, value: string): string {
  return c.localShell === "powershell" ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}
function pythonCommand(c: ContractContext): string {
  return c.localShell ? `${c.localShell === "powershell" ? "& " : ""}${argument(c, c.python)}` : c.python;
}
function helperCommand(c: ContractContext, ...args: string[]): string {
  return `${c.helperCommand || `python3 ${argument(c, c.helper)}`} ${args.map(value => argument(c, value)).join(" ")}`;
}

const COMMON = (c: ContractContext) =>
  [
    `Work only inside ${c.folder}. Before anything else run \`${helperCommand(c, "bootstrap")}\` once (it sets up ${c.python} with python-pptx, matplotlib, pandas, openpyxl, edge-tts and pypdf; it is quick when already done). Use ${pythonCommand(c)} for every Python script you run.`,
    c.inputs.length ? `The user attached these files (already on this computer): ${c.inputs.join(", ")}.` : "",
    `Keep the user informed with the ${c.localShell ? "todo" : "todo_list"} tool. Name each deliverable by its full path in your final answer.`,
  ]
    .filter(Boolean)
    .join(" ");

function slides(c: ContractContext): string {
  const theme = themeById(c.theme);
  const dir = `${c.folder}/${OUTPUT.slides.dir}`;
  return [
    `You are making a slide deck. ${COMMON(c)}`,
    `Steps: (1) research the topic (web_search / ${c.localShell ? "web_fetch" : "web_extract"}) unless the user supplied all the content; (2) outline 6-12 slides with one idea each; (3) write the slides; (4) write speaker notes for every slide (what the presenter says, 40-120 words); (5) check the result visually; (6) finish with a short summary.`,
    `Output contract, exactly:`,
    `- Theme: ${dir}/theme.css is already written (theme "${theme.name}"). Do not edit it. Other themes available if the user asks: ${SLIDE_THEMES.map((t) => t.id).join(", ")}; to switch, tell the user, since the app writes theme.css.`,
    `- One HTML file per slide: ${dir}/01.html, 02.html, ... Each is a complete document: <!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="theme.css"></head><body><div class="slide ...">...</div></body></html>. Exactly 1280x720, nothing may overflow; no external URLs, no web fonts, no scripts.`,
    `- Compose slides from theme.css classes: .slide (add .layout-title, .layout-section, .layout-quote or .center), .eyebrow, h1/.title, h2/.heading, .subtitle/.lead, .rule, ul.bullets, ol.steps, .cols (.three), .card, .stats > .stat > .value + .label, blockquote + .cite, figure > img + figcaption, table, .footer, .band. Max ~40 words of body text per slide. Use colour through var(--accent), var(--accent-2), var(--muted).`,
    `- Images and charts: save them under ${dir}/assets/ and reference them relatively (src="assets/chart.png"). Make charts with matplotlib in the theme's colours (transparent background).`,
    `- Manifest ${dir}/deck.json, written as soon as the outline exists and rewritten as slides are added: {"version":1,"title":"...","subtitle":"...","theme":"${theme.id}","width":1280,"height":720,"slides":[{"file":"01.html","title":"...","layout":"title","notes":"speaker notes"}],"sources":[{"title":"...","url":"..."}]}`,
    `- Visual check: run \`${helperCommand(c, "thumbs", c.folder)}\` and look at ${dir}/thumbs/*.png ${c.localShell ? "using an available image-capable tool or a user-visible preview; if neither is available, say the visual check is unverified" : "with vision_analyze"}; fix any overflow, clipped text or empty slide, then run it again.`,
    `- Do not export PDF or PPTX unless the user asks; the app exports on demand (\`${pythonCommand(c)} ${argument(c, c.helper)} export ${argument(c, c.folder)} <format>\` does it with format pdf, pptx or html if they ask you).`,
    `- Final answer: one short paragraph and the path ${dir}/deck.json. Do not paste slide HTML into the chat.`,
  ].join("\n");
}

function data(c: ContractContext, variant?: GeneratorVariant): string {
  const dir = `${c.folder}/${OUTPUT.data.dir}`;
  const focus =
    variant === "spreadsheet"
      ? `The user wants a spreadsheet. Build a real .xlsx with openpyxl: a header row, sensible column widths, number formats, frozen header, live formulas where values are derived (totals, ratios), and a second sheet for notes or assumptions when useful. Also save the main table as CSV. Add a chart only if it helps.`
      : `The user wants a visualization. Load and clean the data with pandas, pick the chart that answers the question (bar, line, area, scatter, pie only for 2-5 parts), and render each with matplotlib at 1600x1000 px, clear title, labelled axes with units, no chart junk. Also save the cleaned data as CSV.`;
  return [
    `You are doing data analysis. ${COMMON(c)}`,
    focus,
    `If there is no attached data, find or build the dataset (web research, public sources, or a clearly labelled synthetic sample if the user asked for one) and say where it came from.`,
    `Output contract, exactly:`,
    `- Charts: ${dir}/charts/<slug>.png, and next to each the plotted data ${dir}/charts/<slug>.json as {"type":"bar|line|area|scatter|pie","x":"<column>","y":["<column>",...],"columns":[...],"rows":[[...],...]} (the exact numbers plotted, at most 2000 rows).`,
    `- Tables: ${dir}/<name>.xlsx and/or ${dir}/<name>.csv.`,
    `- Report: ${dir}/report.md, a short write-up of findings with the key numbers (it may embed charts as ![title](charts/<slug>.png)).`,
    `- Manifest ${dir}/analysis.json: {"version":1,"title":"...","summary":"two sentences","charts":[{"title":"...","image":"charts/<slug>.png","data":"charts/<slug>.json","caption":"..."}],"tables":[{"title":"...","file":"<name>.xlsx","description":"..."}],"report":"report.md"}. Paths are relative to ${dir}.`,
    `- Final answer: the main findings in 3-5 bullets and the paths of the manifest, the tables and the charts.`,
  ].join("\n");
}

function research(c: ContractContext): string {
  const dir = `${c.folder}/${OUTPUT.research.dir}`;
  return [
    `You are running a research job that may be a batch research job. ${COMMON(c)}`,
    `PHASE 1 (this turn): decide the shape and write the plan, then STOP.`,
    `- If the job covers 5 or more similar, independent items (companies, products, people, papers, cities...), it is "wide". List every item (search first if the user named a category rather than the items; cap at 100), choose the fields to collect per item (3-10 columns), and the deliverable ("table" by default, "report" or "dataset").`,
    `- Otherwise it is "single": an ordinary research report.`,
    `- Write ${dir}/plan.json: {"version":1,"mode":"wide|single","title":"...","fields":["..."],"items":[{"id":"001","name":"..."}],"deliverable":"table","batchSize":5}. Item ids are zero-padded, in order.`,
    `- For "wide": end your turn with ONE short message: how many items, the fields, and that the app is showing the user a cost estimate to confirm. Do NOT start any sub-agent and do not research the items yet. The user's next message will confirm.`,
    `- For "single": do not stop; go straight on to research and write the report (below).`,
    c.localShell
      ? `PHASE 2 (after the user confirms "wide"): research items yourself in batches of batchSize using web_search and web_fetch. Do not call delegate_task: it is not a local tool. Do NOT end your turn until research.json is written: no progress-only replies between batches.`
      : `PHASE 2 (after the user confirms "wide"): run the items with delegate_task in parallel batches of batchSize. Always call delegate_task with background=false so each batch runs in parallel and returns its results inside this turn. Do NOT end your turn until research.json is written: no progress-only replies between batches.`,
    `- Before each batch write ${dir}/progress.json: {"running":["001","002",...]}.`,
    `- ${c.localShell ? "For each item, collect the requested fields" : "Each sub-agent gets one item, the fields, and this instruction"}: research the item with web_search/${c.localShell ? "web_fetch" : "web_extract"}, then write ${dir}/items/<id>.json as {"id":"<id>","name":"...","status":"done","fields":{"<field>":"<value>",...},"sources":["url",...]} (or "status":"failed" with "error"). Write each item file before proceeding.`,
    `- After the last batch, rerun any failed item once, then write {"running":[]} to progress.json.`,
    `MERGE: read every items/*.json and write one deliverable: ${dir}/result.csv (one row per item, the fields as columns, plus a sources column) and ${dir}/report.md (findings, patterns, notable outliers, method). Then write ${dir}/research.json: {"version":1,"title":"...","table":"result.csv","report":"report.md","summary":"two sentences"}.`,
    `For "single" write ${dir}/report.md with citations and ${dir}/research.json with "report":"report.md" (and "table" if you made one).`,
    `Final answer: 3-5 bullets of findings and the paths of research.json, result.csv and report.md.`,
  ].join("\n");
}

function audio(c: ContractContext): string {
  const dir = `${c.folder}/${OUTPUT.audio.dir}`;
  return [
    `You are making spoken audio (narration, voiceover, read-aloud). ${COMMON(c)}`,
    `Speech engine: edge-tts, invoked as \`${pythonCommand(c)} -m edge_tts\`. This is a network service, not offline speech synthesis. List voices with --list-voices; good defaults: en-US-AriaNeural, en-US-GuyNeural, en-GB-SoniaNeural, en-US-AndrewMultilingualNeural. Use --rate/--pitch for pacing. Write the script first (natural sentences, no markup), then synthesise: \`${pythonCommand(c)} -m edge_tts --voice en-US-AriaNeural --file ${argument(c, `${dir}/script.txt`)} --write-media ${argument(c, `${dir}/narration.mp3`)}\`. For several speakers, render each line and join them with ffmpeg (concat demuxer).`,
    ...(c.vendorAudio?.speech
      ? [
          `Better voices: the omtools tool generate_speech (ElevenLabs) renders a script into ${dir}/<file>.mp3 and returns the path. It counts against the user's daily speech limit (characters), so render each final script once; fall back to edge-tts if it reports a limit or an error.`,
        ]
      : []),
    c.vendorAudio?.soundEffects
      ? `Sound effects: the omtools tool generate_sound_effect (prompt, seconds up to 22, file) saves ${dir}/<file>.mp3 and counts against the user's daily limit. Mix effects under narration with ffmpeg when asked. Music is not available: if asked, say so plainly and offer narration or sound effects instead.`
      : `This app can make speech only. Music and sound effects are not available: if asked, say so plainly and offer narration instead.`,
    `Output contract: audio files in ${dir}/, the script beside each as <slug>.txt, and the manifest ${dir}/audio.json: {"version":1,"title":"...","tracks":[{"title":"...","file":"<slug>.mp3","voice":"...","text":"the script","durationSec":12.3}]} (duration from \`ffprobe -v error -show_entries format=duration -of csv=p=0\`).`,
    `Final answer: one line per track and the path of audio.json.`,
  ].join("\n");
}

function nativeMediaInstructions(c: ContractContext, kind: "image" | "video"): string {
  const tools = c.mediaTools?.filter(t => t.kind === kind) || [];
  return tools.length
    ? `Configured MCP generation tools: ${JSON.stringify(tools)}. Use mcp with the given server and no tool first to inspect the actual input schema, then call mcp with that server, tool and arguments. Download or copy actual generated results into the output folder; never treat a remote URL as an existing local artifact.`
    : `No built-in ${kind}_generate tool is installed. Configure a generation MCP connector, or explain the limitation and offer ${kind === "image" ? "a clearly labelled SVG illustration" : "a storyboard"}. Do not claim that ${kind === "image" ? "an image" : "a video"} was generated unless a real file exists.`;
}

function image(c: ContractContext): string {
  const dir = `${c.folder}/${OUTPUT.image.dir}`;
  return [
    c.localShell
      ? `You are helping create images. ${COMMON(c)} ${nativeMediaInstructions(c, "image")}`
      : `You are generating images with the image_generate tool. ${COMMON(c)}`,
    `Save every result under ${dir}/ and write ${dir}/images.json: {"version":1,"title":"...","images":[{"file":"<name>.png","prompt":"..."}]}.`,
  ].join("\n");
}

function video(c: ContractContext): string {
  const dir = `${c.folder}/${OUTPUT.video.dir}`;
  return [
    c.localShell
      ? `You are helping create video. ${COMMON(c)} ${nativeMediaInstructions(c, "video")}`
      : `You are generating video with the video_generate tool. ${COMMON(c)}`,
    `Before generating, describe the shot list and length in one message and ask the user to approve with the clarify tool (choices "Generate", "Cancel"); generate only after "Generate".`,
    `Save results under ${dir}/ and write ${dir}/video.json: {"version":1,"title":"...","videos":[{"file":"<name>.mp4","prompt":"..."}]}.`,
  ].join("\n");
}

export function contractFor(kind: GeneratorKind, variant: GeneratorVariant | undefined, ctx: ContractContext): string {
  const body =
    kind === "slides" ? slides(ctx) : kind === "data" ? data(ctx, variant) : kind === "research" ? research(ctx) : kind === "audio" ? audio(ctx) : kind === "image" ? image(ctx) : video(ctx);
  return `${GENERATOR_TAG(kind, variant)}\n${body}`;
}
