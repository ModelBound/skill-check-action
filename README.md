# ModelBound Skill Check Action

GitHub Action that lints, trust-scores, and estimates token savings for agent skill files on every pull request.

## Quick start

1. Create an `mb_live_` API key at [modelbound.co/settings/api-keys](https://modelbound.co/settings/api-keys).
2. Add it as a repository secret: `MODELBOUND_API_KEY`.
3. Add `.github/workflows/modelbound-skills.yml`:

```yaml
name: ModelBound Skill Check
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  skill-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ModelBound/skill-check-action@v1.0.1
        with:
          mode: full
        env:
          MODELBOUND_API_KEY: ${{ secrets.MODELBOUND_API_KEY }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `full` | `lint`, `trust`, `optimize`, or `full` |
| `skills-glob` | see action.yml | Globs for skill files |
| `publish-report` | `true` | Publish public badge data to modelbound.co |
| `api-url` | `https://modelbound.co` | API base URL |
| `min-trust` | `0` | Fail if average trust is below this score |
| `comment` | `true` | Post a PR summary comment |
| `mcp-version` | `0.4.6` | Pin for local lint via `modelbound-mcp` |

## Modes

- **lint** — local SKILL.md lint only (no API key)
- **trust** — lint + cloud trust scoring
- **optimize** — lint + optimize dry-run estimate
- **full** — lint + trust + optimize + public report for README badges

## README badges

After a successful `full` run:

```markdown
![ModelBound Skill Trust](https://modelbound.co/api/badge/skills.svg?repo=OWNER/REPO)
![Skill Lint](https://modelbound.co/api/badge/skills.svg?repo=OWNER/REPO&metric=lint)
![Optimize Savings](https://modelbound.co/api/badge/skills.svg?repo=OWNER/REPO&metric=optimize)
```

## Links

- [Setup guide](https://modelbound.co/connect/github-actions)
- [Starter workflow repo](https://github.com/ModelBound/skill-check)
- [ModelBound CLI](https://www.npmjs.com/package/modelbound)
