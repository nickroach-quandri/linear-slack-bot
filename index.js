import express from "express";
import { LinearClient } from "@linear/sdk";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ────────────────────────────────────────────────────────────────

function since30Days() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

async function fetchTickets(customerQuery) {
  const cutoff = since30Days();

  // Fetch all issues updated in the last 30 days
  const issuesResult = await linear.issues({
    filter: {
      updatedAt: { gte: cutoff },
    },
    first: 250,
  });

  const issues = issuesResult.nodes;

  // Filter client-side by customer name appearing in title, description, or labels
  const q = customerQuery.toLowerCase();

  const matched = [];
  for (const issue of issues) {
    const state = await issue.state;
    const labels = await issue.labels();
    const labelNames = labels.nodes.map((l) => l.name.toLowerCase());
    const team = await issue.team;

    const titleMatch = issue.title.toLowerCase().includes(q);
    const descMatch = (issue.description || "").toLowerCase().includes(q);
    const labelMatch = labelNames.some((l) => l.includes(q));
    const teamMatch = team?.name?.toLowerCase().includes(q);

    if (titleMatch || descMatch || labelMatch || teamMatch) {
      matched.push({
        id: issue.identifier,
        title: issue.title,
        status: state?.name || "Unknown",
        stateType: state?.type || "unknown",  // started | completed | cancelled | backlog | unstarted
        priority: issue.priority,
        updatedAt: issue.updatedAt,
        url: issue.url,
        assignee: (await issue.assignee)?.name || "Unassigned",
      });
    }
  }

  return matched;
}

function categorize(tickets) {
  const now = new Date();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(now.getDate() - 7);

  const inProgress = [];
  const completed = [];
  const overdue = [];

  for (const t of tickets) {
    const updated = new Date(t.updatedAt);
    const isStale = updated < sevenDaysAgo;

    if (t.stateType === "completed") {
      completed.push(t);
    } else if (t.stateType === "started") {
      if (isStale) {
        overdue.push(t); // In-progress but not touched in 7+ days → stale/overdue
      } else {
        inProgress.push(t);
      }
    } else if (["unstarted", "backlog"].includes(t.stateType)) {
      // Only include open/unstarted if updated recently
      if (!isStale) inProgress.push(t);
    }
  }

  return { inProgress, completed, overdue };
}

async function buildSummary(customer, tickets) {
  if (tickets.length === 0) {
    return `No Linear tickets found for *${customer}* in the last 30 days.`;
  }

  const { inProgress, completed, overdue } = categorize(tickets);

  const ticketData = JSON.stringify({ inProgress, completed, overdue }, null, 2);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `You are a CSM assistant. Generate a concise Slack summary for customer "${customer}" based on their Linear tickets from the last 30 days.

Use this exact Slack markdown structure:

*Linear Summary — ${customer}* (Last 30 days)

${overdue.length > 0 ? "🔴 *Overdue / Stale*\n• [list tickets]" : ""}
${inProgress.length > 0 ? "🟡 *In Progress*\n• [list tickets]" : ""}
${completed.length > 0 ? "✅ *Recently Completed*\n• [list tickets]" : ""}

📊 *At a Glance*
[2–3 sentence plain-English summary of the customer's ticket health and any notable trends or blockers]

Rules:
- Each ticket line: "• [ID] <url|Title> — Assignee"
- Keep it tight — no fluff
- If a section is empty, omit it entirely
- Use the real ticket URLs from the data

Ticket data:
${ticketData}`,
      },
    ],
  });

  return msg.content[0].text;
}

async function postToSlack(responseUrl, text) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "in_channel", text }),
  });
}

// ── Slash command endpoint ─────────────────────────────────────────────────

app.post("/slack/linear-summary", async (req, res) => {
  const { text, response_url, user_name } = req.body;
  const customer = (text || "").trim();

  if (!customer) {
    return res.json({
      response_type: "ephemeral",
      text: "⚠️ Please provide a customer name. Usage: `/linear-summary brokerlink`",
    });
  }

  // Acknowledge immediately (Slack requires a response within 3s)
  res.json({
    response_type: "ephemeral",
    text: `🔍 Fetching Linear tickets for *${customer}*... this may take a moment.`,
  });

  // Do the heavy work async
  try {
    const tickets = await fetchTickets(customer);
    const summary = await buildSummary(customer, tickets);
    await postToSlack(response_url, summary);
  } catch (err) {
    console.error(err);
    await postToSlack(
      response_url,
      `❌ Something went wrong fetching tickets for *${customer}*: ${err.message}`
    );
  }
});

// Health check
app.get("/", (_, res) => res.send("linear-slack-bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
