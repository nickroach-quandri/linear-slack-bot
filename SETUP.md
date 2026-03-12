# Linear → Slack Summary Bot — Setup Guide

Type `/linear-summary brokerlink` in any Slack channel and get an instant, AI-generated ticket summary for that customer.

---

## How It Works

```
CSM types: /linear-summary brokerlink
      ↓
Slack sends the command to your hosted server
      ↓
Server fetches matching Linear tickets (last 30 days)
      ↓
Claude summarizes them into structured sections
      ↓
Summary is posted back into Slack
```

**Output format:**
```
Linear Summary — Brokerlink (Last 30 days)

🔴 Overdue / Stale
• ENG-42 [Title] — Jane Smith

🟡 In Progress
• ENG-55 [Title] — John Doe
• ENG-61 [Title] — Jane Smith

✅ Recently Completed
• ENG-38 [Title] — John Doe

📊 At a Glance
3 active tickets, 1 stale. The authentication bug (ENG-42) 
hasn't been updated in 9 days and may need attention.
```

---

## Step 1 — Deploy to Railway (free)

1. Go to [railway.app](https://railway.app) and sign up
2. Click **New Project → Deploy from GitHub repo**
3. Push this folder to a GitHub repo and connect it
4. Railway will auto-detect Node.js and deploy it
5. Go to **Settings → Networking → Generate Domain**
6. Copy your public URL (e.g. `https://linear-slack-bot.up.railway.app`)

> **Alternative:** [Render.com](https://render.com) works the same way — free tier, connect GitHub, auto-deploy.

---

## Step 2 — Add Environment Variables

In Railway dashboard → your service → **Variables**, add:

| Variable | Value |
|---|---|
| `LINEAR_API_KEY` | Your Linear API key (see below) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

**Get your Linear API key:**
1. Linear → Settings → API → Personal API keys
2. Create a new key with read access

**Get your Anthropic API key:**
1. [console.anthropic.com](https://console.anthropic.com) → API Keys

---

## Step 3 — Create the Slack Slash Command

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From Scratch**
2. Name it `Linear Summary Bot`, select your workspace
3. In the left sidebar → **Slash Commands → Create New Command**

| Field | Value |
|---|---|
| Command | `/linear-summary` |
| Request URL | `https://YOUR-RAILWAY-URL.up.railway.app/slack/linear-summary` |
| Short Description | `Get a Linear ticket summary for a customer` |
| Usage Hint | `[customer name]` |

4. Click **Save**
5. Go to **Install App → Install to Workspace** and authorize it

---

## Step 4 — Test It

In any Slack channel:
```
/linear-summary brokerlink
```

You'll see a loading message, then the summary posts within ~10 seconds.

---

## How Customers Are Matched in Linear

The bot searches for the customer name across:
- **Ticket titles** — e.g. "Brokerlink: Login issue"
- **Ticket descriptions** — any mention of the customer
- **Labels** — e.g. a label named "brokerlink"
- **Team name** — if you have a dedicated team per customer

> **Tip:** The most reliable approach is to use a consistent **label** per customer in Linear (e.g. label: `brokerlink`). This makes matching precise and avoids false positives.

---

## Customization

### Change the time window
In `index.js`, find `since30Days()` and adjust the number of days:
```js
d.setDate(d.getDate() - 60); // last 60 days
```

### Support date in the command
To support `/linear-summary brokerlink 60d`, update the slash command handler:
```js
const parts = (text || "").trim().split(" ");
const customer = parts[0];
const days = parseInt(parts[1]) || 30;
```

### Post to a specific channel
Instead of using `response_url`, use the Slack Web API:
```js
await fetch("https://slack.com/api/chat.postMessage", {
  headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  body: JSON.stringify({ channel: "#customer-updates", text: summary })
});
```

---

## Files

```
linear-slack-bot/
├── index.js          # Main server + all logic
├── package.json      # Dependencies
├── .env.example      # Environment variable template
└── SETUP.md          # This guide
```
