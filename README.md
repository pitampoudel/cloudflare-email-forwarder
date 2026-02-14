# Cloudflare Email Forwarder to Slack

A Cloudflare Email Worker that forwards incoming emails to Slack channels or direct messages, and optionally forwards them to specified email addresses.

## Setup

### 1. Configure Environment Variables

Before deploying, set up the required environment variables:

#### Set Slack Bot Token (Secret)
```bash
npx wrangler secret put SLACK_BOT_TOKEN
```
Enter your Slack bot token when prompted.

#### Set Fallback Slack Channel ID (Variable)
```bash
npx wrangler secret put FALLBACK_CHANNEL_ID
```
Use the channel ID the bot is invited to (not a name like #support).

#### Set Email Routing Configuration
```bash
npx wrangler secret put ROUTES_JSON
```
Enter your routing JSON when prompted (see example below).

#### Set SMTP Fallback Configuration (Optional)
If email forwarding via `message.forward()` fails, the worker can send emails using SMTP credentials:

```bash
npx wrangler secret put SMTP_FROM
npx wrangler secret put SMTP_HOST
npx wrangler secret put SMTP_PORT
npx wrangler secret put SMTP_USERNAME
npx wrangler secret put SMTP_PASSWORD
```

- `SMTP_FROM` – Sender email address for the SMTP fallback
- `SMTP_HOST` – SMTP relay host (use `api.mailchannels.net` for free MailChannels integration, or your own SMTP HTTP relay)
- `SMTP_PORT` – SMTP relay port (default: `587`)
- `SMTP_USERNAME` – SMTP relay username
- `SMTP_PASSWORD` – SMTP relay password

Alternatively, you can set these variables in the Cloudflare dashboard:
- Go to Workers & Pages > Your Worker > Settings > Variables
- Add `SLACK_BOT_TOKEN` as an encrypted variable
- Add `FALLBACK_CHANNEL_ID` as an encrypted variable
- Add `ROUTES_JSON` as an encrypted variable

### 2. Deploy

With the `wrangler.toml` configuration file, simply run:
```bash
npx wrangler deploy
```

The wrangler.toml file ensures your environment variables are preserved across deployments.

### ROUTES_JSON Format Example
```json
{
  "ceo@yourcompany.com": {
    "type": "dm",
    "user": "U06TDCJGP4H",
    "forwardTo": "ceo-personal@example.com"
  },
  "support@yourcompany.com": {
    "id": "C06SXQKQC2H",
    "type": "channel",
    "forwardTo": "support-team@example.com"
  }
}
```

The `forwardTo` field is optional. When present, the worker will:
1. Forward the email to Slack (as before)
2. Forward the email to the specified address using Cloudflare's native `message.forward()`
3. If `message.forward()` fails, fall back to sending via the configured SMTP relay
