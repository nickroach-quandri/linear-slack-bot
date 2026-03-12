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
  // Fetch all open/active issues (no date filter so we catch ALL open tickets)
  const issuesResult = await linear.issues({
    filter: {
      state: {
        type: { in: ["unstarted", "started", "backlog"] },
      },
    },
    first: 250,
  });

  // Also fetch recently completed in last 30 days
  const cutoff = since30Days();
  const completedResult = await linear.issues({
    filter: {
      state: { type: { eq: "completed" } },
      updatedAt: { gte: cutoff },
    },
    first: 100,
  });

  const issues = [...issuesResult.nodes, ...completedResult.nodes];

  // Filter client-side by customer name
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
        status: state?.name || "Unknown",    // exact name e.g. "In Progress", "QA", "Review"
        stateType: state?.type || "unknown", // started | completed | cancelled | backlog | unstarted
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
  const inProgress = [];
  const review = [];
  const qa = [];
  const completed = [];
  const todo = [];
  const backlog = [];

  for (const t of tickets) {
    const statusLower = t.status.toLowerCase();

    if (statusLower.includes("progress")) {
      inProgress.push(t);
    } else if (statusLower.includes("review")) {
      review.push(t);
    } else if (statusLower === "qa" || statusLower.includes("qa")) {
      qa.push(t);
    } else if (t.stateType === "completed") {
      completed.push(t);
    } else if (
      statusLower.includes("todo") ||
      statusLower.includes("to-do") ||
      statusLower.includes("to do") ||
      t.stateType === "unstarted"
    ) {
      todo.push(t);
    } else if (t.stateType === "backlog" || statusLower.includes("backlog")) {
      backlog.push(t);
    } else {
      // Catch-all for any other started states
      inProgress.push(t);
    }
  }

  return { inProgress, review, qa, completed, todo, backlog };
}

async function buildSummary(customer, tickets) {
  if (tickets.length === 0) {
    return `No Linear tickets found for *${customer}*.`;
  }

  const { inProgress, review, qa, completed, todo, backlog } = categorize(tickets);

  const ticketData = JSON.stringify(
    { inProgress, review, qa, completed, todo, backlog },
    null,
    2
  );

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `You are a CSM assistant. Generate a concise Slack summary for customer "${customer}" based on their Linear tickets.

Use this exact Slack markdown structure:

*Linear Summary — ${customer}*

🔵 *In Progress* — list each ticket with assignee and a one-line status note
🔍 *In Review* — list each ticket with assignee and a one-line status note
🧪 *QA* — list each ticket with assignee and a one-line status note
✅ *Recently Completed* (last 30 days) — list each ticket with assignee
📋 *To-Do & Backlog* — do NOT list individual tickets; instead write 2-3 sentences summarising themes, e.g. "8 to-do and 12 backlog items, mostly related to policy matching and download director issues."

📊 *At a Glance*
[3-4 sentence plain-English summary of overall ticket health, any blockers, and what the CSM should be aware of]

Rules:
- Each detailed ticket line format: "• [ID] <url|Title> — Assignee"
- Keep it tight — no fluff
- If a section has no tickets, omit it entirely
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
