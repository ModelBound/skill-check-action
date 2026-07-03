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
const publishReport = process.env.INPUT_PUBLISH_REPORT !== "false";
const apiUrl = (process.env.INPUT_API_URL || "https://modelbound.co").replace(/\/$/, "");
const minTrust = Number(process.env.INPUT_MIN_TRUST || "0");
const shouldComment = process.env.INPUT_COMMENT !== "false";
const scanAllOnMain = process.env.INPUT_SCAN_ALL_ON_MAIN === "true";
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
];
const globInput = process.env.INPUT_SKILLS_GLOB || defaultGlobs.join("\n");
const patterns = globInput.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

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

function listAllSkillFiles() {
  return execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f && fs.existsSync(f) && isSkillPath(f));
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
  return listAllSkillFiles();
}

function resolveSkillFiles() {
  const changed = getChangedFiles();
  const changedSkills = changed.filter((f) => fs.existsSync(f) && isSkillPath(f));
  if (changedSkills.length) return changedSkills;

  const onMainPush =
    process.env.GITHUB_EVENT_NAME === "push" &&
    (process.env.GITHUB_REF === "refs/heads/main" || event.ref === "refs/heads/main");
  if (scanAllOnMain && onMainPush) {
    const all = listAllSkillFiles();
    if (all.length) {
      console.log(
        `ModelBound skill check: no changed skill files — scanning all ${all.length} tracked file(s) on main (scan-all-on-main).`,
      );
      return all;
    }
  }
  return [];
}

function parseSkill(relPath) {
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
  return { path: relPath, name, description, body_md: raw };
}

function runLint(files) {
  const lines = [];
  let failed = false;
  const lintCwd = os.tmpdir();
  for (const file of files) {
    const absFile = path.resolve(file);
    const r = spawnSync(
      "npx",
      ["-y", `--package=modelbound-mcp@${mcpVersion}`, "modelbound-mcp", "lint", absFile],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: lintCwd },
    );
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (out) lines.push(out);
    if (r.status !== 0) failed = true;
  }
  return { failed, lines };
}

async function runAudit(files, lintLines) {
  const auditMode =
    mode === "optimize" ? "optimize-dry-run" : mode === "full" ? "full" : mode === "trust" ? "trust" : null;
  if (!auditMode) return null;
  if (!apiKey) {
    throw new Error(
      `mode=${mode} requires MODELBOUND_API_KEY. Add it as a repository secret, or use mode=lint for local-only checks.`,
    );
  }
  const githubRunUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;
  const res = await fetch(`${apiUrl}/api/cli/skill-audit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: auditMode,
      repo,
      workflow_run_id: String(runId),
      github_run_url: githubRunUrl,
      is_public: publishReport,
      scanned_files: files,
      lint_output: lintLines,
      skills: files.map(parseSkill),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`skill-audit HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function reportPageUrl() {
  return `${apiUrl}/connect/github-actions?repo=${encodeURIComponent(repo)}`;
}

function formatFindings(audit, lintLines, lintFailed) {
  const lines = [];
  const results = Array.isArray(audit?.results) ? audit.results : [];

  if (lintFailed && lintLines.length) {
    lines.push("#### MCP lint errors", "", "```text", ...lintLines, "```", "");
  }

  const withFindings = results.filter((r) => Array.isArray(r?.trust?.findings) && r.trust.findings.length);
  if (withFindings.length) {
    lines.push("#### Trust & safety findings", "");
    for (const r of withFindings) {
      lines.push(`**\`${r.path}\`** — ${r.trust.total}/100 (${r.tier ?? "—"})`);
      for (const f of r.trust.findings) {
        const icon = f.severity === "critical" ? "🔴" : f.severity === "warn" ? "🟡" : "ℹ️";
        lines.push(`- ${icon} **${f.severity}** · ${f.class}: ${f.message}`);
        if (f.hint) lines.push(`  - _Hint:_ ${f.hint}`);
      }
      lines.push("");
    }
  } else if (results.length) {
    lines.push("#### Trust & safety findings", "", "No findings — all scanned skills passed heuristics.", "");
  }

  return lines;
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
  const skillFiles = resolveSkillFiles();
  const githubRunUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;
  const pageUrl = reportPageUrl();

  if (!skillFiles.length) {
    console.log("ModelBound skill check: no skill files to scan — skipping.");
    console.log(`Badge may reflect the last published report. View report: ${pageUrl}`);
    console.log(`Latest workflow run: ${githubRunUrl}`);
    setOutput("skills-scanned", "0");
    setOutput("lint-status", "pass");
    setOutput("report-url", pageUrl);
    setOutput("github-run-url", githubRunUrl);
    return;
  }

  console.log(`ModelBound skill check: scanning ${skillFiles.length} file(s) in mode=${mode}`);
  skillFiles.forEach((f) => console.log(`  • ${f}`));

  let lintFailed = false;
  let lintLines = [];
  if (mode === "lint" || mode === "trust" || mode === "optimize" || mode === "full") {
    const lint = runLint(skillFiles);
    lintFailed = lint.failed;
    lintLines = lint.lines;
    if (lintLines.length) console.log(lintLines.join("\n\n"));
  }

  let audit = null;
  if (mode === "trust" || mode === "optimize" || mode === "full") {
    audit = await runAudit(skillFiles, lintLines);
    console.log(JSON.stringify(audit.summary ?? audit, null, 2));
  }

  const summary = audit?.summary;
  const avgTrust = summary?.avg_trust ?? null;
  const lintStatus = summary?.lint_status ?? (lintFailed ? "fail" : "pass");
  const badgeUrl = audit?.badge_url ?? `https://modelbound.co/api/badge/skills.svg?repo=${encodeURIComponent(repo)}`;
  const storedReportUrl = audit?.report_url ?? pageUrl;

  setOutput("skills-scanned", String(skillFiles.length));
  if (avgTrust != null) setOutput("avg-trust", String(avgTrust));
  setOutput("lint-status", lintStatus);
  setOutput("badge-url", badgeUrl);
  setOutput("report-url", storedReportUrl);
  setOutput("github-run-url", githubRunUrl);

  const mdLines = [
    "### ModelBound Skill Check",
    "",
    `**Mode:** \`${mode}\` · **Files:** ${skillFiles.length}`,
    "",
    ...skillFiles.map((f) => `- \`${f}\``),
    "",
  ];
  if (summary) {
    mdLines.push(
      `| Metric | Value |`,
      `| --- | --- |`,
      `| Trust | ${summary.avg_trust ?? "—"}/100 |`,
      `| Status | ${summary.lint_status ?? "—"} |`,
      `| Findings | ${summary.findings_count ?? 0} |`,
      `| Optimize savings (est.) | ${summary.optimize_savings_pct != null ? `${summary.optimize_savings_pct}%` : "—"} |`,
      "",
      `_Status reflects trust/safety heuristics (critical → fail, warn → warn). MCP lint output is listed separately when present._`,
      "",
      ...formatFindings(audit, lintLines, lintFailed),
      `[View full report](${storedReportUrl}) · [Workflow run](${githubRunUrl}) · [Badge](${badgeUrl})`,
    );
  } else if (lintFailed) {
    mdLines.push("#### MCP lint errors", "", "```text", ...lintLines, "```", "", `[Workflow run](${githubRunUrl})`);
  } else {
    mdLines.push("**Lint:** passed", "", `[Workflow run](${githubRunUrl})`);
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
