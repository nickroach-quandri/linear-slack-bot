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

// ── Fetch all customers matching the query name ────────────────────────────

async function findCustomer(customerQuery) {
  const data = await linearQuery(`
    query FindCustomer($query: String!) {
      customers(filter: { name: { containsIgnoreCase: $query } }, first: 10) {
        nodes { id name updatedAt }
      }
    }
  `, { query: customerQuery });
  // Pick most recently updated customer (avoids grabbing legacy duplicates like "Brokerlink-Standard")
  const nodes = data.customers.nodes;
  if (!nodes.length) return null;
  return nodes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
}

// ── Fetch all issues linked to a customer via customer needs ───────────────

async function fetchIssuesByCustomer(customerId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  // Paginate through all customer needs for this customer
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

  // Extract and deduplicate issues
  const seen = new Set();
  const tickets = [];

  for (const need of allNeeds) {
    const issue = need.issue;
    if (!issue || seen.has(issue.id)) continue;
    seen.add(issue.id);

    const stateType = issue.state?.type || "unknown";
    const updatedAt = new Date(issue.updatedAt);

    // Skip cancelled tickets
    if (stateType === "cancelled") continue;
    // Skip completed tickets older than 30 days
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

// ── Build AI summary ───────────────────────────────────────────────────────

async function buildSummary(customerName, tickets) {
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
    const customer = await findCustomer(customerQuery);

    if (!customer) {
      await postToSlack(response_url,
        `⚠️ No customer found matching "*${customerQuery}*" in Linear. Check the spelling matches the Customers field exactly.`
      );
      return;
    }

    const tickets = await fetchIssuesByCustomer(customer.id);
    const summary = await buildSummary(customer.name, tickets);
    await postToSlack(response_url, summary);
  } catch (err) {
    console.error(err);
    await postToSlack(response_url,
      `❌ Something went wrong fetching tickets for *${customerQuery}*: ${err.message}`
    );
  }
});

// Health check
app.get("/", (_, res) => res.send("linear-slack-bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
