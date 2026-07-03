#!/usr/bin/env node
/**
 * ModelBound skill-check-action runner.
 * Tier 1: modelbound-mcp lint (no API key)
 * Tier 2–3: POST /api/cli/skill-audit (requires MODELBOUND_API_KEY)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const COMMENT_MARKER = "<!-- modelbound-skill-check -->";

const mode = (process.env.INPUT_MODE || "full").toLowerCase();
const scanScope = (process.env.INPUT_SCAN_SCOPE || "changed").toLowerCase();
const cloudRepo = (process.env.INPUT_CLOUD_REPO || "").trim();
const cloudRepoFallback = (process.env.INPUT_CLOUD_REPO_FALLBACK || "").trim();
const publishReport = process.env.INPUT_PUBLISH_REPORT !== "false";
const apiUrl = (process.env.INPUT_API_URL || "https://modelbound.co").replace(/\/$/, "");
const mcpUrl = process.env.INPUT_MCP_URL || "https://mcp.modelbound.co/mcp?source=skill-check-action";
const minTrust = Number(process.env.INPUT_MIN_TRUST || "0");
const shouldComment = process.env.INPUT_COMMENT !== "false";
const mcpVersion = process.env.INPUT_MCP_VERSION || "0.4.6";
const apiKey = process.env.MODELBOUND_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));

const defaultGlobs = [
  ".modelbound/**/*.md",
  ".cursor/rules/**/*.mdc",
  ".cursor/rules/**/*.md",
  ".claude/skills/**/SKILL.md",
  ".kiro/skills/**/*.md",
  ".github/skills/**/SKILL.md",
  "skills/**/SKILL.md",
  "skills/**/*.md",
];
const globInput = process.env.INPUT_SKILLS_GLOB || defaultGlobs.join("\n");
const patterns = globInput.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "dist", "build"]);

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  fs.appendFileSync(out, `${name}=${String(value ?? "")}\n`);
}

function globMatch(relPath, pattern) {
  const re = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`^${re}$`).test(relPath);
}

function matchesAnyGlob(relPath) {
  return patterns.some((p) => globMatch(relPath, p));
}

function isSkillPath(relPath) {
  return /\.(md|mdc)$/i.test(relPath) && matchesAnyGlob(relPath);
}

function getChangedFiles() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  try {
    if (eventName === "pull_request") {
      const base = event.pull_request.base.sha;
      const head = event.pull_request.head.sha;
      return execSync(`git diff --name-only ${base}...${head}`, { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (eventName === "push" && event.before && event.before !== "0".repeat(40)) {
      return execSync(`git diff --name-only ${event.before} ${event.after}`, { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch {
    /* fall through */
  }
  return execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getAllFilesystemSkillFiles() {
  const root = process.cwd();
  const out = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (isSkillPath(rel)) out.push(rel);
    }
  }
  walk(root);
  return out;
}

function collectLocalSkillFiles() {
  const candidates = scanScope === "all" ? getAllFilesystemSkillFiles() : getChangedFiles();
  return candidates.filter((f) => fs.existsSync(f) && isSkillPath(f));
}

function parseSkillFile(relPath) {
  const raw = fs.readFileSync(relPath, "utf8");
  let name = path.basename(relPath, path.extname(relPath));
  let description = "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "name") name = val;
      if (m[1] === "description") description = val;
    }
  }
  return { path: relPath, name, description, body_md: raw, lintPath: relPath };
}

function parseMcpToolResult(result) {
  if (!result || typeof result !== "object") return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || [])
    .map((c) => c.text || "")
    .join("\n")
    .trim();
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let mcpReqId = 1;
async function mcpCallTool(toolName, args) {
  if (!apiKey) throw new Error("MODELBOUND_API_KEY required for cloud skill fetch");
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mcpReqId++,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const contentType = res.headers.get("content-type") || "";
  let raw = await res.text();
  if (contentType.includes("text/event-stream")) {
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    raw = dataLines[dataLines.length - 1] || "";
  }
  const body = JSON.parse(raw);
  if (body.error) throw new Error(body.error.message || "MCP error");
  if (body.result?.isError) {
    throw new Error(parseMcpToolResult(body.result)?.error || "MCP tool failed");
  }
  return parseMcpToolResult(body.result);
}

async function listCloudSkillMeta(repoFilter) {
  const args = { limit: 100, cross_repo: true };
  if (repoFilter) args.repo = repoFilter;
  const result = await mcpCallTool("list_skills", args);
  const rows = Array.isArray(result?.skills) ? result.skills : Array.isArray(result) ? result : [];
  return rows;
}

async function fetchCloudSkillPayloads() {
  if (!cloudRepo) return [];
  const tried = new Set();
  const repoCandidates = [cloudRepo, cloudRepoFallback, repo].filter(Boolean);
  let rows = [];

  for (const candidate of repoCandidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    rows = await listCloudSkillMeta(candidate);
    rows = rows.filter((s) => !candidate || !s.repo || s.repo === candidate || s.repo === cloudRepo);
    if (rows.length) break;
  }

  if (!rows.length) {
    rows = await listCloudSkillMeta(null);
    rows = rows.filter((s) => s.repo === cloudRepo || s.repo === repo);
  }

  const payloads = [];
  for (const row of rows) {
    if (!row.id) continue;
    const detail = await mcpCallTool("get_skill", { skill_id: row.id });
    const body =
      (typeof detail === "string" ? detail : null) ||
      detail?.body_md ||
      detail?.content ||
      detail?.markdown ||
      "";
    if (!body.trim()) continue;
    payloads.push({
      path: row.source_path || `.modelbound/${row.name || row.id}.md`,
      name: row.name || row.id,
      description: row.description || "",
      body_md: body,
      lintPath: null,
      source: "cloud",
    });
  }
  return payloads;
}

function mergeSkillPayloads(localPayloads, cloudPayloads) {
  const byKey = new Map();
  for (const p of [...localPayloads, ...cloudPayloads]) {
    const key = `${p.path}::${p.name}`.toLowerCase();
    byKey.set(key, p);
  }
  return [...byKey.values()];
}

function materializeLintPaths(payloads) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-skill-check-"));
  for (const p of payloads) {
    if (p.lintPath && fs.existsSync(p.lintPath)) continue;
    const safe = String(p.name || "skill").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
    const lintPath = path.join(tmpDir, `${safe}.md`);
    fs.writeFileSync(lintPath, p.body_md);
    p.lintPath = lintPath;
  }
  return payloads;
}

function runLint(payloads) {
  const lines = [];
  let failed = false;
  for (const p of payloads) {
    const r = spawnSync(
      "npx",
      ["-y", `modelbound-mcp@${mcpVersion}`, "lint", p.lintPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (out) lines.push(`# ${p.path}\n${out}`);
    if (r.status !== 0) failed = true;
  }
  return { failed, lines };
}

async function runAudit(payloads) {
  const auditMode =
    mode === "optimize" ? "optimize-dry-run" : mode === "full" ? "full" : mode === "trust" ? "trust" : null;
  if (!auditMode) return null;
  if (!apiKey) {
    throw new Error(
      `mode=${mode} requires MODELBOUND_API_KEY. Add it as a repository secret, or use mode=lint for local-only checks.`,
    );
  }
  const res = await fetch(`${apiUrl}/api/cli/skill-audit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: auditMode,
      repo: cloudRepo || repo,
      workflow_run_id: String(runId),
      is_public: publishReport,
      skills: payloads.map(({ path: skillPath, name, description, body_md }) => ({
        path: skillPath,
        name,
        description,
        body_md,
      })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`skill-audit HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function upsertPrComment(markdown) {
  if (!shouldComment || process.env.GITHUB_EVENT_NAME !== "pull_request" || !githubToken) return;
  const prNumber = event.pull_request.number;
  const [owner, name] = repo.split("/");
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const listUrl = `${serverUrl}/api/v3/repos/${owner}/${name}/issues/${prNumber}/comments`;
  const listRes = await fetch(listUrl, { headers });
  const comments = await listRes.json();
  const existing = Array.isArray(comments)
    ? comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER))
    : null;
  const body = `${COMMENT_MARKER}\n${markdown}`;
  if (existing?.id) {
    await fetch(`${serverUrl}/api/v3/repos/${owner}/${name}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  } else {
    await fetch(listUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }
}

async function main() {
  const localFiles = collectLocalSkillFiles();
  const localPayloads = localFiles.map(parseSkillFile);
  const cloudPayloads = cloudRepo ? await fetchCloudSkillPayloads() : [];
  const payloads = mergeSkillPayloads(localPayloads, cloudPayloads);

  if (!payloads.length) {
    const hint = cloudRepo
      ? "No local or cloud skills matched. Check cloud-repo / MODELBOUND_SKILL_REPO in ModelBound."
      : "No skill files matched. Use scan-scope=all and/or cloud-repo for ModelBound-synced skills.";
    console.log(`ModelBound skill check: ${hint} — skipping.`);
    setOutput("skills-scanned", "0");
    setOutput("lint-status", "pass");
    return;
  }

  console.log(
    `ModelBound skill check: scanning ${payloads.length} skill(s) in mode=${mode}` +
      ` (scope=${scanScope}${cloudRepo ? `, cloud=${cloudRepo}` : ""})`,
  );
  for (const p of payloads) {
    console.log(`  • ${p.path}${p.source === "cloud" ? " [cloud]" : ""}`);
  }

  materializeLintPaths(payloads);

  let lintFailed = false;
  let lintLines = [];
  if (mode === "lint" || mode === "trust" || mode === "optimize" || mode === "full") {
    const lint = runLint(payloads);
    lintFailed = lint.failed;
    lintLines = lint.lines;
    if (lintLines.length) console.log(lintLines.join("\n\n"));
  }

  let audit = null;
  if (mode === "trust" || mode === "optimize" || mode === "full") {
    audit = await runAudit(payloads);
    console.log(JSON.stringify(audit.summary ?? audit, null, 2));
  }

  const summary = audit?.summary;
  const avgTrust = summary?.avg_trust ?? null;
  const lintStatus = summary?.lint_status ?? (lintFailed ? "fail" : "pass");
  const badgeRepo = cloudRepo || repo;
  const badgeUrl =
    audit?.badge_url ?? `https://modelbound.co/api/badge/skills.svg?repo=${encodeURIComponent(badgeRepo)}`;

  setOutput("skills-scanned", String(payloads.length));
  if (avgTrust != null) setOutput("avg-trust", String(avgTrust));
  setOutput("lint-status", lintStatus);
  setOutput("badge-url", badgeUrl);

  const mdLines = [
    "### ModelBound Skill Check",
    "",
    `**Mode:** \`${mode}\` · **Skills:** ${payloads.length}`,
    "",
    ...payloads.map((p) => `- \`${p.path}\`${p.source === "cloud" ? " _(cloud)_" : ""}`),
    "",
  ];
  if (summary) {
    mdLines.push(
      `| Metric | Value |`,
      `| --- | --- |`,
      `| Trust | ${summary.avg_trust ?? "—"}/100 |`,
      `| Lint | ${summary.lint_status ?? "—"} |`,
      `| Findings | ${summary.findings_count ?? 0} |`,
      `| Optimize savings (est.) | ${summary.optimize_savings_pct != null ? `${summary.optimize_savings_pct}%` : "—"} |`,
      "",
      `[View badge](${badgeUrl})`,
    );
  } else if (lintFailed) {
    mdLines.push("**Lint:** failed — see workflow logs for details.");
  } else {
    mdLines.push("**Lint:** passed");
  }
  await upsertPrComment(mdLines.join("\n"));

  if (lintFailed) {
    console.error("ModelBound skill check failed: lint errors found.");
    process.exit(1);
  }
  if (minTrust > 0 && avgTrust != null && avgTrust < minTrust) {
    console.error(`ModelBound skill check failed: avg trust ${avgTrust} < min-trust ${minTrust}`);
    process.exit(1);
  }
  if (lintStatus === "fail") {
    console.error("ModelBound skill check failed: critical trust findings.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
