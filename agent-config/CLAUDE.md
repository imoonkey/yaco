# Global Agent Rules

## Critical Rules

### Security
- No hardcoded API keys or secrets
- Environment variables for sensitive data
- Validate all external input

### Code Quality
- Max 400 lines/file, extract when larger
- Immutability by default
- Explicit error handling, no silent failures

### Git
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`

## Agent Skills

### Global (available everywhere)
- `/ultra-think` - Deep strategic thinking for high-impact decisions
- `/strategic-compact` - Context compaction at task boundaries
- `/align` - Align design between Codex and Claude

### Per-Project (stack-specific)
- `/plan` - Create implementation plan before coding
- `/verify` - Run build + lint + tests
- `/build-fix` - Fix build errors incrementally
- `/tdd` - Test-driven development
- `/code-review` - Systematic code review
- `/coding-standards` - Language/framework conventions (auto-applied)
- `/orchestrate` - Chain skills/agents for complex workflows
