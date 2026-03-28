# GitHub Adapter

Implementation-ready scaffold for a future GitHub adapter.

**Status:** Documentation/scaffolding only — no working implementation  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## ⚠️ Important Notice

This directory contains **documentation and scaffolding only**. There is no working GitHub adapter implementation. This scaffold exists to guide future implementation work.

---

## Overview

GitHub is not a chat platform—it's a code collaboration platform. A GitHub adapter bridges issues, pull requests, comments, and review events into ClaudeClaw's event processing pipeline.

### Key Characteristics

- **Platform:** GitHub (github.com or GitHub Enterprise)
- **Inbound Mode:** Repository webhooks
- **Threading:** Issue/PR number + comment ID
- **Auth:** GitHub App (JWT + Installation token)
- **Rate Limits:** 5,000/hour (GitHub Apps), 60/hour (unauthenticated)

### Why GitHub Is Different

| Aspect | Chat Platforms | GitHub |
|--------|---------------|--------|
| **Primary entity** | Message | Issue/PR/Comment |
| **Timing** | Real-time | Event-driven |
| **Context** | Thread/conversation | Repository + Issue/PR # |
| **Actions** | Reply | Comment, review, label, close |
| **Commands** | Natural language | Mention + trigger phrase |
| **Identity** | Platform user | GitHub account |

---

## Environment Variables

```bash
# Required: GitHub App ID (numeric)
GITHUB_APP_ID=123456

# Required: GitHub App Private Key (path to PEM file or base64-encoded)
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
# OR
GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ...

# Required: Webhook secret for signature validation
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional: GitHub Enterprise Server URL (default: github.com)
# GITHUB_API_URL=https://github.your-company.com/api/v3

# Optional: Webhook URL path (if not using default)
# GITHUB_WEBHOOK_PATH=/webhooks/github

# Optional: Allowed repositories (comma-separated, default: all)
# GITHUB_ALLOWED_REPOS=owner/repo1,owner/repo2

# Optional: Default behavior for unknown commands
# GITHUB_DEFAULT_RESPONSE=none  # Options: none, help, comment

# Optional: Enable debug logging
# GITHUB_DEBUG=true
```

---

## GitHub App Setup

### 1. Create GitHub App

1. Go to GitHub → Settings → Developer settings → GitHub Apps
2. Click **New GitHub App**
3. Fill in details:
   - **GitHub App name:** `ClaudeClaw` (must be unique)
   - **Homepage URL:** Your project URL
   - **Webhook URL:** `https://your-domain.com/webhooks/github`
   - **Webhook secret:** Generate a secure random string

### 2. Configure Permissions

Repository permissions (read/write as needed):

| Permission | Access | Purpose |
|------------|--------|---------|
| **Issues** | Read & Write | Read issues, post comments |
| **Pull requests** | Read & Write | Read PRs, post comments, reviews |
| **Contents** | Read | Read repository files for context |
| **Metadata** | Read | Basic repository info (always enabled) |
| **Checks** | Read & Write | Update check runs (optional) |

Subscribe to events:
- Issues
- Issue comment
- Pull request
- Pull request review
- Pull request review comment
- Push (optional)
- Discussion (optional)

### 3. Generate Private Key

1. At bottom of app settings, click **Generate a private key**
2. Download the `.pem` file
3. Store securely (this is the `GITHUB_APP_PRIVATE_KEY_PATH`)

### 4. Install App on Repositories

1. Go to **Install App** in left sidebar
2. Select organization/user account
3. Choose repositories (all or specific)
4. Click **Install**

Note the **Installation ID** (shown in URL or retrieved via API)

### 5. Configure Webhook

Ensure webhook URL is publicly accessible with HTTPS.

---

## Webhook Validation

GitHub signs all webhook payloads:

```
X-Hub-Signature-256: sha256=...
```

### Signature Validation

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

function validateGitHubWebhook(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  
  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### Middleware Example

```typescript
app.post('/webhooks/github', (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const payload = JSON.stringify(req.body);
  
  if (!validateGitHubWebhook(payload, signature, GITHUB_WEBHOOK_SECRET)) {
    return res.status(401).send('Unauthorized');
  }
  
  // Process valid webhook
  processGitHubEvent(req.body);
  res.status(200).send('OK');
});
```

---

## Auth Model

GitHub Apps use JWT + Installation tokens:

### JWT Authentication (App Level)

```typescript
import { sign } from 'jsonwebtoken';

function generateAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  
  return sign({
    iat: now,
    exp: now + 600,  // 10 minutes max
    iss: appId
  }, privateKey, { algorithm: 'RS256' });
}
```

### Installation Token (Repository Level)

```typescript
async function getInstallationToken(
  jwt: string,
  installationId: number
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json'
      }
    }
  );
  
  const data = await response.json();
  return data.token;  // Expires in 1 hour
}
```

### Usage Pattern

```typescript
// 1. Generate JWT (cached for 10 minutes)
const jwt = generateAppJWT(appId, privateKey);

// 2. Get installation token (cached for 1 hour)
const token = await getInstallationToken(jwt, installationId);

// 3. Use token for API calls
const response = await fetch('https://api.github.com/repos/owner/repo/issues', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json'
  }
});
```

---

## Event Types

### Primary Events

| Event | Action | Description |
|-------|--------|-------------|
| `issues` | `opened`, `edited`, `closed`, `reopened` | Issue lifecycle |
| `issue_comment` | `created`, `edited`, `deleted` | Comments on issues/PRs |
| `pull_request` | `opened`, `edited`, `closed`, `synchronize` | PR lifecycle |
| `pull_request_review` | `submitted`, `edited`, `dismissed` | PR reviews |
| `pull_request_review_comment` | `created`, `edited`, `deleted` | Line comments |

### Event Payload Structure

```typescript
interface GitHubWebhookPayload {
  action: string;
  repository: {
    id: number;
    name: string;
    full_name: string;  // "owner/repo"
  };
  installation: {
    id: number;
  };
  sender: {
    login: string;
    id: number;
  };
  // Event-specific data
  issue?: Issue;
  pull_request?: PullRequest;
  comment?: Comment;
}
```

### Normalized Event Mapping

| NormalizedEvent | GitHub Source |
|-----------------|---------------|
| `channel` | `"github"` |
| `sourceEventId` | `comment.id` or `issue.id` |
| `channelId` | `repository.full_name` → `github:${owner}/${repo}` |
| `threadId` | `issue.number` or `pull_request.number` → `issue_${n}` |
| `userId` | `sender.login` |
| `text` | `comment.body` or `issue.body` |
| `metadata.issueNumber` | `issue.number` |
| `metadata.issueState` | `issue.state` |
| `metadata.commentId` | `comment.id` |
| `metadata.eventType` | `issues`, `pull_request`, etc. |

---

## Threading Model

GitHub threading is issue/PR-centric:

### Issue Thread

```
Issue #42 (channelId: github:owner/repo, threadId: issue_42)
├── Opening comment (issue body)
├── Comment #1
├── Comment #2
└── Comment #3
```

### Pull Request Thread

```
PR #43 (channelId: github:owner/repo, threadId: pr_43)
├── Opening description (PR body)
├── Review #1
│   ├── Comment on line 10
│   └── Comment on line 25
├── Comment #1
└── Review #2
```

### Thread ID Generation

```typescript
function getThreadId(event: GitHubEvent): string {
  if (event.issue) {
    return `issue_${event.issue.number}`;
  }
  if (event.pull_request) {
    return `pr_${event.pull_request.number}`;
  }
  return 'unknown';
}
```

---

## Comment/Reply Semantics

### Posting Issue Comments

```typescript
async function postIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({ body })
    }
  );
}
```

### Posting PR Review Comments

```typescript
async function postPRReviewComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  path: string,
  line: number,
  body: string
): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({
        commit_id: commitId,
        path,
        line,
        body
      })
    }
  );
}
```

### Posting PR Reviews

```typescript
async function postPRReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string
): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({ event, body })
    }
  );
}
```

---

## Command Invocation Conventions

### Mention-Based Commands

Users invoke the bot via @mention:

```
@claudeclaw analyze this code
```

Detection:
```typescript
const BOT_USERNAME = 'claudeclaw';
const mentionPattern = new RegExp(`@${BOT_USERNAME}\\s*(.+)`, 'i');

function extractCommand(text: string): string | null {
  const match = text.match(mentionPattern);
  return match ? match[1].trim() : null;
}
```

### Slash Commands (Alternative)

For more formal interactions:

```
/claude analyze
/claude summarize
/claude explain
```

Requires GitHub App configuration for slash commands.

### PR Description Commands

Trigger on PR creation with specific markers:

```markdown
## ClaudeClaw Tasks
- [ ] Review for security issues
- [ ] Suggest refactoring opportunities
```

---

## Check Run/Status Updates

GitHub Apps can post commit statuses and check runs:

### Commit Status (Legacy)

```typescript
await fetch(
  `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      state: 'success',  // pending, success, failure, error
      description: 'Analysis complete',
      context: 'claudeclaw/analysis'
    })
  }
);
```

### Check Run (Modern)

```typescript
await fetch(
  `https://api.github.com/repos/${owner}/${repo}/check-runs`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.antiope-preview+json'
    },
    body: JSON.stringify({
      name: 'ClaudeClaw Analysis',
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',  // success, failure, neutral, cancelled, timed_out, action_required
      output: {
        title: 'Analysis Results',
        summary: 'No issues found'
      }
    })
  }
);
```

---

## Rate Limit Considerations

### GitHub App Rate Limits

| Resource | Limit | Reset |
|----------|-------|-------|
| Authenticated requests | 5,000/hour | Hourly |
| Content downloads | 100MB/repo/hour | Hourly |
| GraphQL API | 5,000 points/hour | Hourly |

### Rate Limit Headers

```
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Reset: 1640995200
X-RateLimit-Used: 1
```

### Secondary Rate Limits

GitHub also enforces "abuse rate limits":
- Rapid sequential requests
- Concurrent requests
- Large content requests

### Best Practices

1. **Cache tokens:** Installation tokens valid for 1 hour
2. **Respect Retry-After:** Header provided on limit hit
3. **Use conditional requests:** `If-None-Match` with ETags
4. **Batch operations:** Use GraphQL for complex queries

---

## Testing Approach

### Local Testing

1. Use [smee.io](https://smee.io) or ngrok for webhook tunneling
2. Configure GitHub App webhook URL to tunnel
3. Trigger events via test issues/PRs

### Mock Events

```typescript
const mockIssueCommentEvent = {
  action: 'created',
  repository: { full_name: 'test-org/test-repo' },
  installation: { id: 12345678 },
  sender: { login: 'testuser' },
  issue: { number: 1, title: 'Test Issue' },
  comment: { id: 12345, body: '@claudeclaw hello' }
};
```

### Integration Testing

Test scenarios:
- Issue comment triggers response
- PR review comment triggers analysis
- @mention command parsing
- Webhook signature validation
- Rate limit handling
- Multi-repo installation

---

## Open Investigation Questions

- [ ] **GitHub App vs OAuth App:** Which is better for our use case?
- [ ] **GraphQL vs REST:** GraphQL more efficient but more complex—tradeoffs?
- [ ] **Enterprise Server:** How different is GHE from github.com?
- [ ] **Actions integration:** Should we integrate with GitHub Actions?
- [ ] **Code suggestions:** Can we use suggestion blocks in reviews?
- [ ] **Private repos:** Any special handling needed?
- [ ] **Large repos:** Performance considerations for big repositories?

---

## Implementation Readiness Checklist

Before implementing this adapter:

- [ ] GitHub App created
- [ ] App ID obtained
- [ ] Private key generated and secured
- [ ] Webhook secret generated and secured
- [ ] App installed on test repository
- [ ] Installation ID noted
- [ ] Required permissions determined
- [ ] Webhook events selected
- [ ] Public HTTPS endpoint available
- [ ] JWT library selected
- [ ] Rate limit handling strategy defined

---

## See Also

- [GitHub Apps Documentation](https://docs.github.com/en/developers/apps)
- [Webhooks Documentation](https://docs.github.com/en/developers/webhooks)
- [REST API Reference](https://docs.github.com/en/rest)
- [GitHub App Best Practices](https://docs.github.com/en/developers/apps/getting-started-with-apps/best-practices-for-creating-a-github-app)
- [Octokit.js](https://github.com/octokit/octokit.js/) — Official GitHub SDK
- [`../README.md`](../README.md) — Adapter architecture overview
- [`../contracts.md`](../contracts.md) — Capability matrix
- [`../configuration.md`](../configuration.md) — Configuration patterns
