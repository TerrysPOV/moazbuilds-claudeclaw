# Email Adapter

Implementation-ready scaffold for a future Email adapter.

**Status:** Documentation/scaffolding only — no working implementation  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## ⚠️ Important Notice

This directory contains **documentation and scaffolding only**. There is no working Email adapter implementation. This scaffold exists to guide future implementation work.

---

## Overview

Email is fundamentally different from chat platforms. It is asynchronous, header-based, and carries significant security and spoofing concerns. This scaffold documents the unique considerations for email integration.

### Key Characteristics

- **Protocol:** IMAP (inbound), SMTP (outbound)
- **Alternative:** Gmail API, Microsoft Graph API
- **Threading:** Header-based (`Message-ID`, `In-Reply-To`, `References`)
- **Auth:** Passwords, app passwords, or OAuth 2.0
- **Rate Limits:** Provider-dependent (Gmail: ~250/day SMTP for free)

### Why Email Is Different

| Aspect | Chat Platforms | Email |
|--------|---------------|-------|
| **Timing** | Real-time | Asynchronous |
| **Threading** | Platform-managed | Header-based chain |
| **Identity** | Platform-verified | Easily spoofed |
| **Delivery** | Guaranteed (internal) | Best-effort (external) |
| **Loop risk** | Low | High (auto-replies) |
| **Format** | Structured | MIME multipart |

---

## Environment Variables

### IMAP/SMTP Approach

```bash
# Required: IMAP server settings (inbound)
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=claudeclaw@example.com
EMAIL_IMAP_PASS=your-app-password

# Required: SMTP server settings (outbound)
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=claudeclaw@example.com
EMAIL_SMTP_PASS=your-app-password

# Optional: Mailbox to monitor (default: INBOX)
EMAIL_MAILBOX=INBOX

# Optional: Polling interval in seconds (default: 60)
EMAIL_POLL_INTERVAL=60

# Optional: Only process emails to this address
# EMAIL_RECIPIENT_FILTER=claudelegclaw@example.com

# Optional: Maximum email size in bytes (default: 10MB)
EMAIL_MAX_SIZE=10485760

# Optional: Auto-reply suppression (comma-separated patterns)
EMAIL_SUPPRESS_PATTERNS="noreply@,no-reply@,do-not-reply@"

# Optional: Require specific subject prefix
# EMAIL_SUBJECT_PREFIX="[ClaudeClaw]"
```

### Gmail API Approach

```bash
# Required: Gmail API credentials
EMAIL_GMAIL_CLIENT_ID=your-client-id
EMAIL_GMAIL_CLIENT_SECRET=your-client-secret
EMAIL_GMAIL_REFRESH_TOKEN=your-refresh-token

# Optional: User email address
EMAIL_GMAIL_USER=claudeclaw@example.com
```

### Microsoft Graph API Approach

```bash
# Required: Microsoft 365 credentials
EMAIL_GRAPH_CLIENT_ID=your-client-id
EMAIL_GRAPH_CLIENT_SECRET=your-client-secret
EMAIL_GRAPH_TENANT_ID=your-tenant-id
EMAIL_GRAPH_USER=claudeclaw@example.com
```

---

## Inbound Options

### Option 1: IMAP Polling (Universal)

**Pros:**
- Works with any email provider
- Simple protocol, well-documented
- No public endpoint needed

**Cons:**
- Polling introduces latency
- Connection management complexity
- Less efficient than push

**Implementation:**
```typescript
// Pseudocode
const imap = new ImapClient({
  host: EMAIL_IMAP_HOST,
  port: EMAIL_IMAP_PORT,
  user: EMAIL_IMAP_USER,
  password: EMAIL_IMAP_PASS,
  tls: true
});

// Poll for new messages
setInterval(async () => {
  await imap.connect();
  const messages = await imap.search({ unseen: true });
  for (const msg of messages) {
    const email = await imap.fetch(msg);
    const normalized = normalizeEmail(email);
    await gateway.processInboundEvent(normalized);
    await imap.markSeen(msg);
  }
  await imap.disconnect();
}, EMAIL_POLL_INTERVAL * 1000);
```

### Option 2: Gmail API Push Notifications

**Pros:**
- Near real-time via Pub/Sub
- Rich metadata without parsing MIME
- Google-managed delivery

**Cons:**
- Gmail-only
- Requires Google Cloud project
- Pub/Sub setup complexity

**Implementation requirements:**
1. Create Google Cloud project
2. Enable Gmail API
3. Configure Pub/Sub topic
4. Set up push subscription
5. Handle webhook notifications

### Option 3: Microsoft Graph Webhooks

**Pros:**
- Near real-time for Microsoft 365
- Direct Exchange integration

**Cons:**
- Microsoft-only
- Azure AD complexity

---

## Threading Model

Email threading is header-based, not platform-managed:

### Key Headers

| Header | Purpose | Example |
|--------|---------|---------|
| `Message-ID` | Unique identifier for this message | `<abc123@example.com>` |
| `In-Reply-To` | References parent message ID | `<parent-abc@example.com>` |
| `References` | Chain of related message IDs | `<grandparent@...> <parent@...>` |
| `Subject` | Human-readable topic | `Re: Original Subject` |

### Thread Detection Algorithm

```typescript
function getThreadId(email: ParsedEmail): string {
  // Priority 1: Use References chain if available
  if (email.references && email.references.length > 0) {
    // Thread ID = first message in chain (root)
    return hashThread(email.references[0]);
  }
  
  // Priority 2: Use In-Reply-To
  if (email.inReplyTo) {
    return hashThread(email.inReplyTo);
  }
  
  // Priority 3: New thread - hash normalized subject
  const normalizedSubject = email.subject
    .replace(/^Re:\s*/i, '')
    .replace(/^Fwd:\s*/i, '');
  return hashThread(normalizedSubject + email.from);
}
```

### Thread ID Format

```typescript
// Hash of root message ID or subject+sender
const threadId = `email:${crypto.createHash('sha256').update(rootId).digest('hex').slice(0, 16)}`;
```

### Outbound Thread Reply

To reply in an email thread:

```typescript
function createReplyEmail(originalEmail: Email, replyText: string): Email {
  return {
    to: originalEmail.from,
    subject: originalEmail.subject.startsWith('Re:') 
      ? originalEmail.subject 
      : `Re: ${originalEmail.subject}`,
    inReplyTo: originalEmail.messageId,
    references: [...(originalEmail.references || []), originalEmail.messageId],
    text: replyText
  };
}
```

---

## Attachment Handling

### Inbound Attachments

```typescript
interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Buffer;  // or stream
  contentId?: string;  // for inline attachments
}
```

**Considerations:**
- Size limits: 25MB typical, 50MB some providers
- Virus scanning: May reject certain types
- Storage: Consider offloading to blob storage
- Inline vs attachment distinction

### Supported Types Mapping

| Email MIME Type | Normalized Type |
|-----------------|-----------------|
| `image/*` | `image` |
| `audio/*` | `voice` |
| `text/plain`, `text/markdown` | `document` |
| `application/pdf` | `document` |
| `application/*` | `document` |

---

## Spoofing and Security Concerns

### The Email Trust Problem

Unlike chat platforms, email sender addresses are easily forged:

```
From: ceo@company.com   ← Can be anyone
```

### Validation Strategies

#### 1. SPF (Sender Policy Framework)

Check if sending server is authorized:

```
# DNS TXT record for company.com
v=spf1 ip4:192.0.2.1 include:_spf.google.com ~all
```

Validation: Does the sending IP match the SPF record?

#### 2. DKIM (DomainKeys Identified Mail)

Cryptographic signature verification:

```
DKIM-Signature: v=1; a=rsa-sha256; d=company.com; ...
```

Validation: Verify signature with public key from DNS.

#### 3. DMARC (Domain-based Message Authentication)

Policy for failed SPF/DKIM:

```
# DNS TXT record for _dmarc.company.com
v=DMARC1; p=reject; rua=mailto:dmarc@company.com
```

Policy options: `none`, `quarantine`, `reject`

#### 4. Implementation Approach

```typescript
async function validateEmailSecurity(email: Email): Promise<SecurityResult> {
  const results = {
    spf: await checkSpf(email.senderIp, email.fromDomain),
    dkim: await checkDkim(email.dkimSignature),
    dmarc: await checkDmarc(email.fromDomain, spf, dkim)
  };
  
  // Reject if DMARC policy is reject and checks failed
  if (results.dmarc.policy === 'reject' && !results.dmarc.alignment) {
    return { valid: false, reason: 'DMARC rejection' };
  }
  
  // Flag for review if quarantine
  if (results.dmarc.policy === 'quarantine' && !results.dmarc.alignment) {
    return { valid: true, flagged: true, reason: 'DMARC quarantine' };
  }
  
  return { valid: true };
}
```

### Recommended Security Settings

```bash
# Require SPF pass
EMAIL_REQUIRE_SPF=true

# Require DKIM pass
EMAIL_REQUIRE_DKIM=false  # Many legitimate emails lack DKIM

# Enforce DMARC policy
EMAIL_ENFORCE_DMARC=true

# Whitelist trusted domains (bypass some checks)
EMAIL_TRUSTED_DOMAINS=company.com,partner.com
```

---

## Loop Prevention

### The Auto-Reply Loop Risk

Two bots emailing each other:

```
Bot A receives email → Sends reply
Bot B receives reply → Sends reply
Bot A receives reply → Sends reply
...forever
```

### Prevention Strategies

#### 1. Header Detection

Check for auto-reply indicators:

```typescript
function isAutoReply(email: Email): boolean {
  const autoReplyHeaders = [
    'X-Auto-Response-Suppress',
    'Auto-Submitted',
    'X-Autoreply',
    'X-AutoReply-From'
  ];
  
  for (const header of autoReplyHeaders) {
    if (email.headers[header]) return true;
  }
  
  // Check Precedence header
  if (email.headers['Precedence']?.includes('auto_reply')) return true;
  if (email.headers['Precedence']?.includes('bulk')) return true;
  
  return false;
}
```

#### 2. Address Suppression

Never reply to these patterns:

```typescript
const SUPPRESSED_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^do-not-reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /-autoreply@/i,
  /@.*\.linkedin\.com$/i,  // LinkedIn notifications
  /@.*\.github\.com$/i     // GitHub notifications (separate adapter)
];
```

#### 3. Reply Rate Limiting

Track replies per thread/sender:

```typescript
interface ReplyTracker {
  threadId: string;
  sender: string;
  replyCount: number;
  lastReplyAt: number;
}

// Max 5 replies per thread per hour
const MAX_REPLIES_PER_THREAD_PER_HOUR = 5;
```

#### 4. Bot Identification Header

Add header to outgoing emails:

```
X-ClaudeClaw-Bot: true
X-ClaudeClaw-Thread-ID: email:abc123
```

Check for own headers in incoming emails.

---

## Rate Limiting

Email providers have strict rate limits:

| Provider | SMTP Limit | Notes |
|----------|------------|-------|
| Gmail | 100/day (new), 500/day (established) | Rolling 24 hours |
| Outlook | 300/day | Per user |
| SendGrid | 100/day (free), much higher (paid) | API-based |
| AWS SES | 14 emails/second | Adjustable |

### Rate Limit Strategy

```typescript
class EmailRateLimiter {
  private sentCount: number = 0;
  private windowStart: number = Date.now();
  
  async canSend(): Promise<boolean> {
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000; // 24 hours
    
    // Reset window
    if (now - this.windowStart > windowMs) {
      this.sentCount = 0;
      this.windowStart = now;
    }
    
    return this.sentCount < DAILY_LIMIT;
  }
  
  recordSend() {
    this.sentCount++;
  }
}
```

---

## Outbound Reply Semantics

### Plain Text Reply

```typescript
const reply = {
  to: originalEmail.from,
  subject: `Re: ${originalEmail.subject.replace(/^Re:\s*/i, '')}`,
  text: replyText,
  inReplyTo: originalEmail.messageId,
  references: [...(originalEmail.references || []), originalEmail.messageId]
};
```

### HTML Reply (with plain text fallback)

```typescript
const reply = {
  to: originalEmail.from,
  subject: `Re: ${originalEmail.subject}`,
  text: plainTextVersion,
  html: `<html>
    <body>
      <div>${escapeHtml(replyText)}</div>
      <br>
      <hr>
      <div>On ${originalEmail.date}, ${originalEmail.from} wrote:</div>
      <blockquote>${escapeHtml(originalEmail.text)}</blockquote>
    </body>
  </html>`,
  inReplyTo: originalEmail.messageId,
  references: [...(originalEmail.references || []), originalEmail.messageId]
};
```

---

## Testing Approach

### Local Testing

1. Create test email account (Gmail, Outlook)
2. Generate app password (not account password)
3. Configure IMAP/SMTP settings
4. Send test emails from another account

### Integration Testing

Test scenarios:
- Plain text email received and replied
- HTML email received and replied
- Email with attachments
- Thread detection (replies in same thread)
- Auto-reply suppression
- Rate limit handling
- Large email rejection

### Security Testing

- SPF/DKIM validation with forged emails
- Loop prevention with auto-responders
- Address suppression patterns

---

## Open Investigation Questions

- [ ] **HTML vs Plain Text:** How to handle rich formatting conversion?
- [ ] **Attachment Size:** What are provider-specific limits?
- [ ] **Bounce Handling:** How to detect and handle bounced emails?
- [ ] **Threading Algorithm:** Validate header-based threading works reliably
- [ ] **Provider APIs:** Gmail API vs IMAP tradeoffs for production?
- [ ] **Email Parsing:** Which library? (nodemailer, mailparser, etc.)
- [ ] **Queue Architecture:** Should we use a mail queue for outbound?

---

## Implementation Readiness Checklist

Before implementing this adapter:

- [ ] Test email account created
- [ ] App password generated (not account password)
- [ ] IMAP/SMTP settings verified working
- [ ] SPF/DKIM validation strategy decided
- [ ] Loop prevention rules defined
- [ ] Rate limits researched for target provider
- [ ] Email parsing library selected
- [ ] Attachment handling strategy defined
- [ ] Security headers to check documented

---

## See Also

- [Nodemailer Documentation](https://nodemailer.com/)
- [IMAP Protocol (RFC 3501)](https://tools.ietf.org/html/rfc3501)
- [Email Threading (RFC 2822)](https://tools.ietf.org/html/rfc2822)
- [SPF Specification](https://tools.ietf.org/html/rfc7208)
- [DKIM Specification](https://tools.ietf.org/html/rfc6376)
- [DMARC Specification](https://tools.ietf.org/html/rfc7489)
- [`../README.md`](../README.md) — Adapter architecture overview
- [`../contracts.md`](../contracts.md) — Capability matrix
- [`../configuration.md`](../configuration.md) — Configuration patterns
