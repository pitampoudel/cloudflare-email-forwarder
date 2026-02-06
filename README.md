# Cloudflare Email Forwarder to Slack

A Cloudflare Email Worker that forwards incoming emails to Slack channels or direct messages.

## Setup

### 1. Configure Environment Variables

Before deploying, set up the required environment variables:

#### Set Slack Bot Token (Secret)
```bash
npx wrangler secret put SLACK_BOT_TOKEN
```
Enter your Slack bot token when prompted.

#### Set Email Routing Configuration
```bash
npx wrangler secret put ROUTES_JSON
```
Enter your routing JSON when prompted (see example below).

**Important:** Make sure to use the variable name `ROUTES_JSON` (not `ROUTES`). The worker code expects this specific variable name.

Alternatively, you can set these variables in the Cloudflare dashboard:
- Go to Workers & Pages > Your Worker > Settings > Variables
- Add `SLACK_BOT_TOKEN` as an encrypted variable
- Add `ROUTES_JSON` as an encrypted variable (ensure the name is exactly `ROUTES_JSON`)

### 2. Deploy

With the `wrangler.toml` configuration file, simply run:
```bash
npx wrangler deploy
```

The wrangler.toml file ensures your environment variables are preserved across deployments.

#### Troubleshooting Deployment Warnings

If you see a warning during deployment about configuration differences (e.g., a `ROUTES` variable in the remote configuration), this means you have an older variable name set in the Cloudflare dashboard. The worker code expects `ROUTES_JSON`, not `ROUTES`.

**To fix this:**
1. Go to Workers & Pages > Your Worker > Settings > Variables in the Cloudflare dashboard
2. If you see a variable named `ROUTES`, copy its value
3. Delete the `ROUTES` variable
4. Create a new encrypted variable named `ROUTES_JSON` with the same value
5. Deploy again - the warning should now be gone

Alternatively, use the wrangler CLI:
```bash
# Set the ROUTES_JSON variable with your routing configuration
npx wrangler secret put ROUTES_JSON
# Paste your routes JSON when prompted
```

### ROUTES_JSON Format Example
```json
{
  "ceo@yourcompany.com": {
    "type": "dm",
    "user": "U06TDCJGP4H"
  },
  "support@yourcompany.com": {
    "id": "C06SXQKQC2H",
    "type": "channel"
  }
}
```
