# Security Policy

## Supported Versions

Taskplane is currently in an experimental/early stage.

As a general policy, security fixes are prioritized for the latest published
release on npm and the `main` branch.

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Older releases | ⚠️ Best effort |
| Unreleased forks | ❌ |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for suspected security problems.

Instead, report vulnerabilities privately using one of the following:

1. **GitHub Security Advisory (preferred):**
   - Go to: https://github.com/HenryLach/taskplane/security/advisories/new
2. **Direct maintainer contact:**
   - https://github.com/HenryLach

When reporting, include:

- A clear description of the issue
- Affected version(s)
- Reproduction steps or proof of concept
- Potential impact
- Any known mitigations

## What Counts as Security-Sensitive

Examples include (but are not limited to):

- Arbitrary command execution through Taskplane inputs or config
- Path traversal / unsafe file operations
- Privilege escalation across worktrees, sessions, or project boundaries
- Leaking secrets/tokens from environment, files, or command output
- Unsafe handling of untrusted task content that could run unintended commands
- Dashboard/API behaviors that expose sensitive local filesystem data

## Response Process

We aim to:

- Acknowledge receipt within **72 hours**
- Triage severity and impact within **7 days**
- Provide status updates as remediation progresses
- Publish a fix and disclosure note once users can safely update

## Coordinated Disclosure

Please allow time for investigation and patching before public disclosure.

After a fix is available, we will coordinate disclosure details (affected
versions, remediation steps, and credits if desired).

## Security Best Practices for Users

- Run Taskplane in trusted repositories
- Review agent prompts and task files before execution
- Avoid storing plaintext secrets in task folders or config
- Keep `pi`, Node.js, and Taskplane updated
- Use project-local installs when sharing repo config with a team
