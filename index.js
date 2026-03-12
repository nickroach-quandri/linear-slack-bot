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

  // Step 1: Find the customer by name to get their ID
  const customersResult = await linear.customers({
    filter: { name: { containsIgnoreCase: customerQuery } },
    first: 5,
  });

  if (!customersResult.nodes.length) {
    return { tickets: [], customerFound: false };
  }

  const customer = customersResult.nodes[0];

  // Step 2: Get all customer needs (which link customers to issues) 
  const needsResult = await linear.customerNeeds({
    filter: { customer: { id: { eq: customer.id } } },
    first: 250,
  });

  if (!needsResult.nodes.length) {
    return { tickets: [], customerFound: true, customerName: customer.name };
  }

  // Step 3: Extract issue IDs from customer needs
  const issueIds = [];
  for (const need of needsResult.nodes) {
    const issue = await need.issue;
    if (issue?.id) issueIds.push(issue.id);
  }

  if (!issueIds.length) {
    return { tickets: [], customerFound: true, customerName: customer.name };
  }

  // Step 4: Fetch full issue details for all linked issues in parallel
  const issueDetails = await Promise.all(
    issueIds.map(async (id) => {
      try {
        const issue = await linear.issue(id);
        const [state, assignee] = await Promise.all([
          issue.state,
          issue.assignee,
        ]);

        const stateType = state?.type || "unknown";
        const updatedAt = new Date(issue.updatedAt);

        // Skip completed tickets older than 30 days
        if (stateType === "completed" && updatedAt < cutoff) return null;
        // Skip cancelled tickets
        if (stateType === "cancelled") return null;

        return {
          id: issue.identifier,
          title: issue.title,
          description: (issue.description || "").slice(0, 200),
          status: state?.name || "Unknown",
          stateType,
          priority: issue.priority,
          updatedAt: issue.updatedAt,
          url: issue.url,
          assignee: assignee?.name || "Unassigned",
        };
      } catch {
        return null;
      }
    })
  );

  const tickets = issueDetails.filter(Boolean);
  return { tickets, customerFound: true, customerName: customer.name };
}

function categorize(tickets) {
  const inProgress = [];
  const review = [];
  const qa = [];
  const completed = [];
  const todo = [];
  const backlog = [];

  for (const t of tickets) {
    const s = t.status.toLowerCase();
    if (s.includes("progress")) inProgress.push(t);
    else if (s.includes("review")) review.push(t);
    else if (s.includes("qa")) qa.push(t);
    else if (t.stateType === "completed") completed.push(t);
    else if (
      s.includes("todo") ||
      s.includes("to-do") ||
      s.includes("to do") ||
      t.stateType === "unstarted"
    ) todo.push(t);
    else if (t.stateType === "backlog" || s.includes("backlog")) backlog.push(t);
    else inProgress.push(t);
  }

  const byPriority = (a, b) => {
    const pa = a.priority === 0 ? 99 : (a.priority || 99);
    const pb = b.priority === 0 ? 99 : (b.priority || 99);
    return pa - pb;
  };

  return {
    inProgress: inProgress.sort(byPriority),
    review: review.sort(byPriority),
    qa: qa.sort(byPriority),
    completed,
    todo: todo.sort(byPriority),
    backlog: backlog.sort(byPriority),
  };
}

async function buildSummary(customerName, tickets) {
  if (!tickets.length) {
    return `No active Linear tickets found for *${customerName}*.`;
  }

  const { inProgress, review, qa, completed, todo, backlog } = categorize(tickets);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You are a CSM assistant. Generate a Slack summary for customer "${customerName}".

EXACT FORMAT:

*Linear Summary — ${customerName}*
_${inProgress.length} In Progress · ${review.length} In Review · ${qa.length} QA · ${todo.length} To-Do · ${backlog.length} Backlog · ${completed.length} Recently Completed_

---

For sections 🔵 In Progress, 🔍 In Review, and 🧪 QA:
List EVERY ticket like this:
• <url|ID - Title> — Assignee · [Priority]
  > One sentence: what is this ticket about?

For ✅ Recently Completed:
• <url|ID - Title> — Assignee
(just list them, no description needed)

For 📋 To-Do (${todo.length} tickets):
List the top 5 by priority:
• <url|ID - Title> — [Priority]
Then 2 sentences on overall themes across all ${todo.length} tickets.

For 📥 Backlog (${backlog.length} tickets):
List the top 5 by priority:
• <url|ID - Title> — [Priority]
Then 2 sentences on overall themes across all ${backlog.length} tickets.

📊 At a Glance:
3-4 sentences on overall health, blockers, and what the CSM should follow up on.

RULES:
- Omit any section that has 0 tickets
- Use real URLs from the data
- Keep it tight

--- TICKET DATA ---

IN PROGRESS:
${JSON.stringify(inProgress, null, 2)}

IN REVIEW:
${JSON.stringify(review, null, 2)}

QA:
${JSON.stringify(qa, null, 2)}

RECENTLY COMPLETED:
${JSON.stringify(completed, null, 2)}

TODO:
${JSON.stringify(todo, null, 2)}

BACKLOG:
${JSON.stringify(backlog, null, 2)}
`,
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
  const { text, response_url } = req.body;
  const customerQuery = (text || "").trim();

  if (!customerQuery) {
    return res.json({
      response_type: "ephemeral",
      text: "⚠️ Please provide a customer name. Usage: `/linear-summary brokerlink`",
    });
  }

  res.json({
    response_type: "ephemeral",
    text: `🔍 Fetching Linear tickets for *${customerQuery}*... hang tight!`,
  });

  try {
    const { tickets, customerFound, customerName } = await fetchTickets(customerQuery);

    if (!customerFound) {
      await postToSlack(
        response_url,
        `⚠️ No customer found matching "*${customerQuery}*" in Linear. Check the spelling matches the Customers field exactly.`
      );
      return;
    }

    const summary = await buildSummary(customerName, tickets);
    await postToSlack(response_url, summary);
  } catch (err) {
    console.error(err);
    await postToSlack(
      response_url,
      `❌ Something went wrong fetching tickets for *${customerQuery}*: ${err.message}`
    );
  }
});

// Health check
app.get("/", (_, res) => res.send("linear-slack-bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
