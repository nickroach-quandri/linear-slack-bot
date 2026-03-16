import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;

// ── Linear GraphQL helper ──────────────────────────────────────────────────

async function linearQuery(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Find customer by name ──────────────────────────────────────────────────

async function findCustomer(customerQuery) {
  const data = await linearQuery(`
    query FindCustomer($query: String!) {
      customers(filter: { name: { containsIgnoreCase: $query } }, first: 10) {
        nodes { id name updatedAt }
      }
    }
  `, { query: customerQuery });
  const nodes = data.customers.nodes;
  if (!nodes.length) return null;
  // Pick most recently updated (avoids legacy duplicates like "Brokerlink-Standard")
  return nodes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
}

// ── Fetch all issues linked to a customer via customer needs ───────────────

async function fetchIssuesByCustomer(customerId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  let allNeeds = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const data = await linearQuery(`
      query GetCustomerNeeds($customerId: ID!, $cursor: String) {
        customerNeeds(
          filter: { customer: { id: { eq: $customerId } } }
          first: 250
          after: $cursor
        ) {
          nodes {
            issue {
              id
              identifier
              title
              description
              url
              priority
              updatedAt
              state { name type }
              assignee { name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { customerId, cursor });

    const page = data.customerNeeds;
    allNeeds = allNeeds.concat(page.nodes);
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  const seen = new Set();
  const tickets = [];

  for (const need of allNeeds) {
    const issue = need.issue;
    if (!issue || seen.has(issue.id)) continue;
    seen.add(issue.id);

    const stateType = issue.state?.type || "unknown";
    const updatedAt = new Date(issue.updatedAt);

    if (stateType === "cancelled") continue;
    if (stateType === "completed" && updatedAt < cutoff) continue;

    tickets.push({
      id: issue.identifier,
      title: issue.title,
      description: (issue.description || "").slice(0, 200),
      status: issue.state?.name || "Unknown",
      stateType,
      priority: issue.priority,
      updatedAt: issue.updatedAt,
      url: issue.url,
      assignee: issue.assignee?.name || "Unassigned",
    });
  }

  return tickets;
}

// ── Categorize and sort tickets ────────────────────────────────────────────

function categorize(tickets) {
  const inProgress = [], review = [], qa = [], completed = [], todo = [], backlog = [];

  for (const t of tickets) {
    const s = t.status.toLowerCase();
    if (s.includes("progress")) inProgress.push(t);
    else if (s.includes("review")) review.push(t);
    else if (s.includes("qa")) qa.push(t);
    else if (t.stateType === "completed") completed.push(t);
    else if (s.includes("todo") || s.includes("to-do") || s.includes("to do") || t.stateType === "unstarted") todo.push(t);
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

// ── Build internal Slack summary ───────────────────────────────────────────

async function buildSlackSummary(customerName, tickets) {
  if (!tickets.length) {
    return `No active Linear tickets found for *${customerName}*.`;
  }

  const { inProgress, review, qa, completed, todo, backlog } = categorize(tickets);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{
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
IN PROGRESS: ${JSON.stringify(inProgress, null, 2)}
IN REVIEW: ${JSON.stringify(review, null, 2)}
QA: ${JSON.stringify(qa, null, 2)}
RECENTLY COMPLETED: ${JSON.stringify(completed, null, 2)}
TODO: ${JSON.stringify(todo, null, 2)}
BACKLOG: ${JSON.stringify(backlog, null, 2)}`,
    }],
  });

  return msg.content[0].text;
}

// ── Build customer-facing email draft ─────────────────────────────────────

async function buildEmailSummary(customerName, tickets) {
  if (!tickets.length) {
    return `No active Linear tickets found for *${customerName}*.`;
  }

  const { inProgress, review, qa, completed, todo, backlog } = categorize(tickets);
  const activeCount = inProgress.length + review.length + qa.length;
  const month = new Date().toLocaleString("default", { month: "long", year: "numeric" });

  // Strip internal-only fields before sending to AI
  const clean = (arr) => arr.map(({ title, description }) => ({ title, description }));

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are a Customer Success Manager writing a polished product update email to a customer called "${customerName}".

Write a professional but warm email they can receive directly. Use plain English — no internal jargon, no ticket IDs, no assignee names, no links.

You MAY reference ticket counts naturally in prose (e.g. "we're actively working on ${activeCount} items for your team").

STRUCTURE (use these exact bold headers):

Subject: Quandri Product Update — ${customerName} | ${month}

Hi [Name],

[1–2 sentence warm opener referencing the month and that this is their regular product update]

**What We're Actively Working On**
[Flowing prose paragraph(s) covering the ${activeCount} active tickets across In Progress, In Review, and QA. Group related items into themes. Write as if explaining to a non-technical business person. No bullet points — full sentences only.]

**Recently Shipped**
[Flowing prose paragraph covering the ${completed.length} completed items. What value did these deliver? Keep it positive and outcome-focused.]

**Coming Up Next**
[Flowing prose paragraph summarising themes from the ${todo.length} to-do and ${backlog.length} backlog items. What are the priorities? What should they expect in the coming weeks?]

[Warm closing sentence inviting questions or a call. Sign off as "The Quandri Team".]

RULES:
- No ticket IDs, no URLs, no assignee names
- No bullet points anywhere — prose only
- Keep each section to 2–4 sentences
- Translate technical titles into plain outcomes (e.g. "Duplicate Policy IN/OUT" becomes "resolving an issue causing duplicate policy entries")
- Tone: professional, warm, confident

--- TICKET DATA ---
IN PROGRESS (${inProgress.length}): ${JSON.stringify(clean(inProgress), null, 2)}
IN REVIEW (${review.length}): ${JSON.stringify(clean(review), null, 2)}
QA (${qa.length}): ${JSON.stringify(clean(qa), null, 2)}
RECENTLY COMPLETED (${completed.length}): ${JSON.stringify(clean(completed), null, 2)}
TODO (${todo.length}): ${JSON.stringify(clean(todo), null, 2)}
BACKLOG (${backlog.length}): ${JSON.stringify(clean(backlog), null, 2)}`,
    }],
  });

  const emailText = msg.content[0].text;

  // Wrap in a code block so it's easy to copy-paste
  return `📧 *Email Draft — ${customerName}*\n_Copy the text below into your email client_\n\`\`\`\n${emailText}\n\`\`\``;
}

// ── Slack helpers ──────────────────────────────────────────────────────────

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
  const parts = (text || "").trim().split(/\s+/);

  // Parse: /linear-summary <customer name> [email]
  const emailMode = parts[parts.length - 1].toLowerCase() === "email";
  const customerQuery = emailMode ? parts.slice(0, -1).join(" ") : parts.join(" ");

  if (!customerQuery) {
    return res.json({
      response_type: "ephemeral",
      text: "⚠️ Please provide a customer name.\nUsage:\n• `/linear-summary brokerlink` — internal Slack summary\n• `/linear-summary brokerlink email` — customer-ready email draft",
    });
  }

  const modeLabel = emailMode ? "📧 email draft" : "📋 Slack summary";

  res.json({
    response_type: "ephemeral",
    text: `🔍 Generating ${modeLabel} for *${customerQuery}*... hang tight!`,
  });

  try {
    const customer = await findCustomer(customerQuery);

    if (!customer) {
      await postToSlack(response_url,
        `⚠️ No customer found matching "*${customerQuery}*" in Linear. Check the spelling matches the Customers field exactly.`
      );
      return;
    }

    const tickets = await fetchIssuesByCustomer(customer.id);
    const summary = emailMode
      ? await buildEmailSummary(customer.name, tickets)
      : await buildSlackSummary(customer.name, tickets);

    await postToSlack(response_url, summary);
  } catch (err) {
    console.error(err);
    await postToSlack(response_url,
      `❌ Something went wrong for *${customerQuery}*: ${err.message}`
    );
  }
});

// Health check
app.get("/", (_, res) => res.send("linear-slack-bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
