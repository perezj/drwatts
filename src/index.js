const MAX_ROWS = 200;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function isAdmin(request, env) {
  const allowed = clean(env.ADMIN_EMAIL, 320).toLowerCase();
  const signedIn = clean(request.headers.get("Cf-Access-Authenticated-User-Email"), 320).toLowerCase();
  return Boolean(allowed && signedIn && signedIn === allowed);
}

function unauthorized() {
  return new Response("Admin access required.", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

async function notifyByEmail(lead, env) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.LEAD_RECIPIENT_EMAIL) {
    return false;
  }

  const subject = `New ${lead.type.toLowerCase()} estimate request from ${lead.name}`;
  const text = [
    "New estimate request",
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    `Email: ${lead.email || "Not provided"}`,
    `Type: ${lead.type}`,
    `Service: ${lead.service || "Not selected"}`,
    `Preferred contact: ${lead.contact}`,
    `Details: ${lead.details || "None provided"}`,
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [env.LEAD_RECIPIENT_EMAIL],
      reply_to: lead.email || undefined,
      subject,
      text,
      html: `<h2>New estimate request</h2><p><strong>Name:</strong> ${escapeHtml(lead.name)}</p><p><strong>Phone:</strong> ${escapeHtml(lead.phone)}</p><p><strong>Email:</strong> ${escapeHtml(lead.email || "Not provided")}</p><p><strong>Type:</strong> ${escapeHtml(lead.type)}</p><p><strong>Service:</strong> ${escapeHtml(lead.service || "Not selected")}</p><p><strong>Preferred contact:</strong> ${escapeHtml(lead.contact)}</p><p><strong>Details:</strong><br>${escapeHtml(lead.details || "None provided").replaceAll("\n", "<br>")}</p>`,
    }),
  });

  if (!response.ok) {
    console.error("Resend notification failed", response.status, await response.text());
  }
  return response.ok;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

async function createLead(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const lead = {
    type: clean(body.type, 40) || "Commercial",
    name: clean(body.name, 120),
    phone: clean(body.phone, 60),
    email: clean(body.email, 320),
    service: clean(body.service, 120),
    details: clean(body.details, 4000),
    contact: clean(body.contact, 40) || "Call",
  };

  if (!lead.name || !lead.phone) {
    return json({ error: "Name and phone are required." }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO leads (type, name, phone, email, service, details, contact, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
  ).bind(lead.type, lead.name, lead.phone, lead.email, lead.service, lead.details, lead.contact).run();

  ctx.waitUntil(notifyByEmail(lead, env));
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function listLeads(request, env) {
  if (!isAdmin(request, env)) return unauthorized();
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, type, name, phone, email, service, details, contact, status
     FROM leads ORDER BY id DESC LIMIT ?`,
  ).bind(MAX_ROWS).all();
  return json({ leads: results });
}

function adminPage() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DrWatts Leads</title><style>body{margin:0;background:#101418;color:#eef1f4;font:15px system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:28px 18px}h1{color:#f2b705}table{width:100%;border-collapse:collapse;background:#161b21}th,td{text-align:left;padding:12px;border:1px solid #2a323c;vertical-align:top}th{color:#f2b705}td{white-space:pre-wrap}small{color:#93a0ae}</style></head><body><main><h1>Estimate Requests</h1><p><small>Newest requests appear first.</small></p><table><thead><tr><th>Date</th><th>Contact</th><th>Type / Service</th><th>Details</th><th>Status</th></tr></thead><tbody id="rows"><tr><td colspan="5">Loading…</td></tr></tbody></table></main><script>fetch('/admin/api/leads').then(r=>{if(!r.ok)throw new Error('Access denied');return r.json()}).then(({leads})=>{const rows=document.getElementById('rows');rows.innerHTML=leads.length?leads.map(l=>'<tr><td>'+esc(l.created_at)+'</td><td><strong>'+esc(l.name)+'</strong><br>'+esc(l.phone)+'<br>'+esc(l.email||'')+'<br>Preferred: '+esc(l.contact)+'</td><td>'+esc(l.type)+'<br>'+esc(l.service||'')+'</td><td>'+esc(l.details||'')+'</td><td>'+esc(l.status)+'</td></tr>').join(''):'<tr><td colspan="5">No requests yet.</td></tr>'}).catch(e=>{document.getElementById('rows').innerHTML='<tr><td colspan="5">'+esc(e.message)+'</td></tr>'});function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</script></body></html>`, { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/leads" && request.method === "POST") return createLead(request, env, ctx);
    if (url.pathname === "/admin/api/leads" && request.method === "GET") return listLeads(request, env);
    if (url.pathname === "/admin/leads" && request.method === "GET") return isAdmin(request, env) ? adminPage() : unauthorized();
    return env.ASSETS.fetch(request);
  },
};
