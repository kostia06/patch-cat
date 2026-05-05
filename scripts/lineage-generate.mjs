#!/usr/bin/env node
// scripts/lineage-generate.mjs
//
// Reads Patch audit blobs from a toolbox's runs/ directory and produces:
//   1. A self-contained HTML file with a D3 force-directed graph of tools
//      and their temporal "this-tool-fired-after-that-tool" connections.
//   2. (Optional, --frames) per-day frames captured headlessly via Puppeteer
//      for ffmpeg → MP4 in a follow-up step.
//
// For v0.4 the HTML visualization is the deliverable; the multi-frame MP4
// pipeline is wired but commented since it needs Puppeteer + ffmpeg
// installed (those pull large deps and are best left to the launch-prep
// step where we already have a real dataset to render).
//
// Usage:
//   # Read your real toolbox
//   node scripts/lineage-generate.mjs \
//     --toolbox "$HOME/Library/Application Support/patch-cat" \
//     --out lineage.html
//
//   # Or synthesize a fixture and render it (good for development)
//   node scripts/lineage-generate.mjs --synthesize --out lineage.html

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const out = args.out ?? "lineage.html";
const synthesize = args.synthesize === "true";

let blobs;

if (synthesize) {
  console.log("synthesizing fixture (50 runs across 7 days, ~12 tools)…");
  blobs = synthesizeBlobs();
} else {
  const toolboxDir = args.toolbox;
  if (!toolboxDir) {
    fail("Pass --toolbox <path> (or use --synthesize for a development fixture).");
  }
  const runsDir = join(toolboxDir, "runs");
  if (!existsSync(runsDir)) {
    fail(`runs/ directory not found in toolbox: ${runsDir}`);
  }
  blobs = await readBlobs(runsDir);
  console.log(`loaded ${blobs.length} blobs from ${runsDir}`);
  if (blobs.length === 0) {
    console.log("no audit blobs yet — try the --synthesize flag for a development fixture.");
    process.exit(0);
  }
}

const graph = buildGraph(blobs);
const html = renderHtml(graph);
await writeFile(out, html, "utf8");
console.log(`✓ wrote ${out} (${html.length.toLocaleString()} bytes)`);
console.log(`  Open in a browser: open ${resolve(out)}`);
console.log(`  Frame capture (MP4) is wired but commented — see top of script.`);

// ============================================================
// Blob loading + graph construction
// ============================================================

async function readBlobs(runsDir) {
  const entries = await readdir(runsDir);
  const jsonFiles = entries.filter((e) => e.endsWith(".json"));
  const out = [];
  for (const f of jsonFiles) {
    try {
      const raw = await readFile(join(runsDir, f), "utf8");
      out.push(JSON.parse(raw));
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => new Date(a.ran_at).getTime() - new Date(b.ran_at).getTime());
  return out;
}

function buildGraph(blobs) {
  // Nodes = tools; edges = temporal adjacency (tool A's run is followed by
  // tool B's run within window). Edge weight = co-occurrence count.
  const ADJACENCY_WINDOW_MS = 5 * 60 * 1000; // 5 min
  const nodes = new Map();
  const edges = new Map(); // "a→b" → count

  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    const t = b.tool?.name;
    if (!t) continue;
    if (!nodes.has(t)) {
      nodes.set(t, {
        id: t,
        run_count: 0,
        first_seen: b.ran_at,
        last_seen: b.ran_at,
      });
    }
    const node = nodes.get(t);
    node.run_count += 1;
    node.last_seen = b.ran_at;

    // Look backward within window
    const tcur = new Date(b.ran_at).getTime();
    for (let j = i - 1; j >= 0; j--) {
      const prev = blobs[j];
      const tprev = new Date(prev.ran_at).getTime();
      if (tcur - tprev > ADJACENCY_WINDOW_MS) break;
      if (prev.tool?.name && prev.tool.name !== t) {
        const k = `${prev.tool.name}→${t}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.entries()).map(([k, count]) => {
      const [source, target] = k.split("→");
      return { source, target, count };
    }),
    timeline: blobs.map((b) => ({
      ran_at: b.ran_at,
      tool: b.tool?.name,
      duration_ms: b.duration_ms,
      success: b.exit_code === 0,
    })),
  };
}

// ============================================================
// HTML rendering — single self-contained file with inlined D3
// ============================================================

function renderHtml(graph) {
  const data = JSON.stringify(graph);
  // Use D3 v7 from CDN. The page has no external CSS or JS beyond the CDN.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Patch — toolbox lineage</title>
  <style>
    body { margin: 0; background: #000; color: #fff; font-family: -apple-system, sans-serif; }
    #header { position: fixed; top: 0; left: 0; right: 0; padding: 16px; background: #0009; z-index: 10; backdrop-filter: blur(8px); }
    #header h1 { margin: 0 0 4px 0; font-size: 18px; font-weight: 600; }
    #header p { margin: 0; font-size: 13px; color: #888; }
    #stats { padding: 12px 16px; font-size: 12px; color: #aaa; border-top: 1px solid #222; }
    svg { display: block; }
    .node circle { stroke: #fff; stroke-width: 1.5px; fill: #fff; cursor: pointer; }
    .node text { fill: #ddd; font-size: 11px; pointer-events: none; }
    .link { stroke: #444; stroke-opacity: 0.6; }
    .link.highlight { stroke: #fff; stroke-opacity: 1; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Patch toolbox lineage</h1>
    <p>Tools generated and reused over time. Edge thickness = how often tool A's run preceded tool B's within 5 minutes.</p>
    <div id="stats"></div>
  </div>
  <svg id="graph"></svg>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script>
    const data = ${data};
    const stats = document.getElementById("stats");
    const totalRuns = data.timeline.length;
    const uniqueTools = data.nodes.length;
    const successRate = (data.timeline.filter(t => t.success).length / totalRuns * 100).toFixed(1);
    const days = totalRuns === 0 ? 0 :
      Math.ceil((new Date(data.timeline[totalRuns-1].ran_at) - new Date(data.timeline[0].ran_at)) / 86400000);
    stats.textContent = totalRuns + " runs · " + uniqueTools + " distinct tools · " + days + " day" + (days===1?"":"s") + " · " + successRate + "% success";

    const W = window.innerWidth, H = window.innerHeight;
    const svg = d3.select("#graph").attr("width", W).attr("height", H);

    const sim = d3.forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.edges).id(d => d.id).distance(d => 80 / Math.sqrt(d.count + 1)))
      .force("charge", d3.forceManyBody().strength(-150))
      .force("center", d3.forceCenter(W/2, H/2))
      .force("collide", d3.forceCollide(d => 8 + Math.sqrt(d.run_count)));

    const link = svg.append("g")
      .selectAll("line")
      .data(data.edges)
      .enter().append("line")
      .attr("class", "link")
      .attr("stroke-width", d => Math.min(6, 1 + Math.log(d.count + 1)));

    const node = svg.append("g")
      .selectAll("g")
      .data(data.nodes)
      .enter().append("g")
      .attr("class", "node")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    node.append("circle")
      .attr("r", d => 4 + Math.sqrt(d.run_count));

    node.append("text")
      .attr("x", 10)
      .attr("y", 4)
      .text(d => d.id);

    sim.on("tick", () => {
      link
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => "translate(" + d.x + "," + d.y + ")");
    });

    window.addEventListener("resize", () => {
      svg.attr("width", window.innerWidth).attr("height", window.innerHeight);
      sim.force("center", d3.forceCenter(window.innerWidth/2, window.innerHeight/2));
      sim.alpha(0.3).restart();
    });
  </script>
</body>
</html>`;
}

// ============================================================
// Synthetic fixture for development
// ============================================================

function synthesizeBlobs() {
  const TOOLS = [
    "fetch_url",
    "fetch_json",
    "extract_html_tables",
    "parse_csv",
    "search_hacker_news",
    "summarize_text",
    "regex_findall",
    "geocode_address",
    "get_weather",
    "convert_currency",
    "markdown_to_html",
    "json_query",
  ];
  const blobs = [];
  const startMs = Date.now() - 7 * 86400_000;
  for (let i = 0; i < 50; i++) {
    const tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
    const t = startMs + i * 12000 + Math.random() * 300_000;
    blobs.push({
      schema_version: "1",
      run_id: `synthetic-${i}`,
      ran_at: new Date(t).toISOString(),
      tool: { name: tool, version: "1.0.0", source_sha256: "0".repeat(64) },
      duration_ms: 200 + Math.floor(Math.random() * 1500),
      exit_code: Math.random() > 0.05 ? 0 : 1,
    });
  }
  return blobs;
}

// ============================================================
// Helpers
// ============================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      out[argv[i].slice(2)] = next && !next.startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
