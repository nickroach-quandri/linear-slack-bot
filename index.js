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

// Fetches ALL pages from a Linear paginated result
async function fetchAllPages(queryFn) {
  let results = [];
  let cursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await queryFn(cursor);
    results = results.concat(page.nodes);
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return results;
}

async function fetchTickets(customerQuery) {
  const q = customerQuery.toLowerCase();

  // Fetch ALL open/active issues with pagination
  const openIssues = await fetchAllPages((cursor) =>
    linear.issues({
      filter: {
        state: { type: { in: ["unstarted", "started", "backlog"] } },
      },
      first: 250,
      after: cursor,
    })
  );

  // Fetch recently completed (last 30 days) with pagination
  const cutoff = since30Days();
  const completedIssues = await fetchAllPages((cursor) =>
    linear.issues({
      filter: {
        state: { type: { eq: "completed" } },
        updatedAt: { gte: cutoff },
      },
      first: 250,
      after: cursor,
    })
  );

  const allIssues = [...openIssues, ...completedIssues];

  // Filter by customer name across title, description, labels, team
  const matched = [];
  for (const issue of allIssues) {
    const state = await issue.state;
    const labels = await issue.labels();
    const labelNames = labels.nodes.map((l) => l.name.toLowerCase());
    const team = await issue.team;

    const titleMatch = issue.title.toLowerCase().includes(q);
    const descMatch = (issue.description || "").toLowerCase().includes(q);
    const labelMatch = labelNames.some((l) => l.includes(q));
    const teamMatch = team?.name?.toLowerCase().includes(q);

    if (titleMatch || descMatch || labelMatch || teamMatch) {
      // Fetch the latest comment on the ticket for "latest update"
      const comments = await issue.comments({ first: 1, orderBy: "updatedAt" });
      const latestComment = comments.nodes[0]?.body || null;

      matched.push({
        id: issue.identifier,
        title: issue.title,
        description: (issue.description || "").slice(0, 300), // trim long descriptions
        status: state?.name || "Unknown",
        stateType: state?.type || "unknown",
        priority: issue.priority, // 0=none,1=urgent,2=high,3=medium,4=low
        updatedAt: issue.updatedAt,
        url: issue.url,
        assignee: (await issue.assignee)?.name || "Unassigned",
        latestComment: latestComment ? latestComment.slice(0, 200) : null,
      });
    }
  }

  return matched;
}

function priorityLabel(p) {
  return ["No priority", "Urgent", "High", "Medium", "Low"][p] || "No priority";
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
    else if (s.includes("todo") || s.includes("to-do") || s.includes("to do") || t.stateType === "unstarted") todo.push(t);
    else if (t.stateType === "backlog" || s.includes("backlog")) backlog.push(t);
    else inProgress.push(t); // catch-all
  }

  // Sort each active group by priority (1=urgent first)
  const byPriority = (a, b) => (a.priority || 99) - (b.priority || 99);
  inProgress.sort(byPriority);
  review.sort(byPriority);
  qa.sort(byPriority);
  todo.sort(byPriority);
  backlog.sort(byPriority);

  return { inProgress, review, qa, completed, todo, backlog };
}

async function buildSummary(customer, tickets) {
  if (tickets.length === 0) {
    return `No Linear tickets found for *${customer}*.`;
  }

  const { inProgress, review, qa, completed, todo, backlog } = categorize(tickets);

  const ticketData = JSON.stringify(
    { inProgress, review, qa, completed, todo, backlog },
    null, 2
  );

  const totalActive = inProgress.length + review.length + qa.length;
  const totalQueued = todo.length + backlog.length;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You are a CSM assistant. Generate a Slack summary for customer "${customer}".

EXACT FORMAT TO USE:

*Linear Summary — ${customer}*
_${inProgress.length} In Progress · ${review.length} In Review · ${qa.length} QA · ${todo.length} To-Do · ${backlog.length} Backlog · ${completed.length} Recently Completed_

---

🔵 *In Progress (${inProgress.length})*
For each ticket write:
• <url|ID - Title> — _Assignee_ · Priority
  > One sentence describing what this ticket is about.
  > Latest update: [summarise the latestComment if available, otherwise say "No recent comments."]

🔍 *In Review (${review.length})*
[Same format as In Progress]

🧪 *QA (${qa.length})*
[Same format as In Progress]

✅ *Recently Completed*
• <url|ID - Title> — _Assignee_
[Just list these, no update needed]

📋 *To-Do (${todo.length} tickets)*
Link the top 5 highest priority tickets like:
• <url|ID - Title> — _Priority_
Then write 2-3 sentences summarising the overall themes across ALL ${todo.length} to-do tickets.

📥 *Backlog (${backlog.length} tickets)*
Link the top 5 highest priority tickets like:
• <url|ID - Title> — _Priority_
Then write 2-3 sentences summarising the overall themes across ALL ${backlog.length} backlog tickets.

📊 *At a Glance*
3-4 sentences: overall health, key blockers, what the CSM should flag or follow up on.

---
RULES:
- Use real URLs from the data
- If a section has 0 tickets, omit it entirely
- Keep descriptions tight — no fluff
- Format ticket links as: <https://linear.app/...|ID - Title>

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
  const { text, response_url } = req.body;
  const customer = (text || "").trim();

  if (!customer) {
    return res.json({
      response_type: "ephemeral",
      text: "⚠️ Please provide a customer name. Usage: `/linear-summary brokerlink`",
    });
  }

  // Acknowledge immediately (Slack requires response within 3s)
  res.json({
    response_type: "ephemeral",
    text: `🔍 Fetching all Linear tickets for *${customer}*... this may take 15–30 seconds.`,
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
