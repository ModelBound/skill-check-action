#!/usr/bin/env node
/**
 * ModelBound skill-check-action runner.
 * Tier 1: modelbound-mcp lint (no API key)
 * Tier 2–3: POST /api/cli/skill-audit (requires MODELBOUND_API_KEY)
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const COMMENT_MARKER = "<!-- modelbound-skill-check -->";

const mode = (process.env.INPUT_MODE || "full").toLowerCase();
const publishReport = process.env.INPUT_PUBLISH_REPORT !== "false";
const apiUrl = (process.env.INPUT_API_URL || "https://modelbound.co").replace(/\/$/, "");
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
  return new RegExp(`^${re}$").test(relPath);
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
  for (const file of files) {
    const r = spawnSync(
      "npx",
      ["-y", `modelbound-mcp@${mcpVersion}`, "lint", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (out) lines.push(out);
    if (r.status !== 0) failed = true;
  }
  return { failed, lines };
}

async function runAudit(files) {
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
      repo,
      workflow_run_id: String(runId),
      is_public: publishReport,
      skills: files.map(parseSkill),
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
  const changed = getChangedFiles();
  const skillFiles = changed.filter((f) => fs.existsSync(f) && isSkillPath(f));

  if (!skillFiles.length) {
    console.log("ModelBound skill check: no changed skill files matched the configured globs — skipping.");
    setOutput("skills-scanned", "0");
    setOutput("lint-status", "pass");
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
    audit = await runAudit(skillFiles);
    console.log(JSON.stringify(audit.summary ?? audit, null, 2));
  }

  const summary = audit?.summary;
  const avgTrust = summary?.avg_trust ?? null;
  const lintStatus = summary?.lint_status ?? (lintFailed ? "fail" : "pass");
  const badgeUrl = audit?.badge_url ?? `https://modelbound.co/api/badge/skills.svg?repo=${encodeURIComponent(repo)}`;

  setOutput("skills-scanned", String(skillFiles.length));
  if (avgTrust != null) setOutput("avg-trust", String(avgTrust));
  setOutput("lint-status", lintStatus);
  setOutput("badge-url", badgeUrl);

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
