// app/api/ai-odoo/route.ts
import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildSystemPrompt() {
  const now = new Date();
  const today = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const in1year = new Date(now); in1year.setFullYear(in1year.getFullYear() + 1);
  const in6months = new Date(now); in6months.setMonth(in6months.getMonth() + 6);
  const in3months = new Date(now); in3months.setMonth(in3months.getMonth() + 3);
  const todayStr = today;
  const in3mStr = in3months.toISOString().split("T")[0];
  const in6mStr = in6months.toISOString().split("T")[0];
  const in1yStr = in1year.toISOString().split("T")[0];

  return `Tu es un générateur de requêtes Odoo JSON-RPC. Tu reçois une question et tu retournes UNIQUEMENT du JSON, rien d'autre.

RÈGLE ABSOLUE: Ta réponse doit commencer par { et finir par }. Aucun texte avant, aucun texte après, aucun markdown.

Date du jour: ${todayStr}
Dans 3 mois: ${in3mStr}
Dans 6 mois: ${in6mStr}
Dans 1 an: ${in1yStr}

Modèles Odoo disponibles:
- product.template: produits (name, default_code, list_price, standard_price, type, categ_id, active, barcode)
- product.product: variantes (name, default_code, list_price, standard_price, barcode)
- stock.quant: stock (product_id, location_id, quantity, reserved_quantity, lot_id) — filtre location_id.usage="internal"
- stock.location: emplacements (name, complete_name, usage, active)
- stock.picking: bons transfert (name, state, picking_type_code, date, partner_id, origin, scheduled_date)
- stock.move.line: lignes mouvement (product_id, lot_id, qty_done, quantity, location_id, location_dest_id, picking_id)
- stock.lot: lots/séries (name, product_id, expiration_date, product_qty, ref)
- purchase.order: commandes fournisseur (name, state, partner_id, amount_total, date_order, date_planned)
- sale.order: commandes client (name, state, partner_id, amount_total, date_order)
- res.partner: partenaires (name, email, phone, supplier_rank, customer_rank)
- product.category: catégories (name, complete_name)

Règles critiques pour les DATES (format Odoo = "YYYY-MM-DD"):
- Lots expirant dans 1 an: [["expiration_date","!=",false],["expiration_date",">=","${todayStr}"],["expiration_date","<=","${in1yStr}"]]
- Lots expirant dans 6 mois: [["expiration_date","!=",false],["expiration_date",">=","${todayStr}"],["expiration_date","<=","${in6mStr}"]]
- Lots expirant dans 3 mois: [["expiration_date","!=",false],["expiration_date",">=","${todayStr}"],["expiration_date","<=","${in3mStr}"]]
- Lots déjà expirés: [["expiration_date","!=",false],["expiration_date","<","${todayStr}"]]
- NE JAMAIS utiliser du Python ou des calculs dans les domains, uniquement des strings YYYY-MM-DD

Autres règles:
- Recherche texte: opérateur "ilike" (insensible casse, partiel)
- Échantillons: stock.quant avec [["product_id.name","ilike","echantillon"],["location_id.usage","=","internal"]]
- Stock dispo = quantity - reserved_quantity
- picking_type_code: incoming=réception, outgoing=OUT livraison, internal=transfert interne
- state picking: draft, waiting, confirmed, assigned=prêt, done=validé, cancel
- Si demande de reformatage/tableau des données déjà affichées: retourne {"queries":[],"reformat":true}

Format JSON obligatoire (exemple lots expirant dans 1 an):
{"queries":[{"model":"stock.lot","domain":[["expiration_date","!=",false],["expiration_date",">=","${todayStr}"],["expiration_date","<=","${in1yStr}"]],"fields":["name","product_id","expiration_date","product_qty"],"limit":100,"order":"expiration_date asc","description":"lots expirant dans 1 an"}]}`;
}

async function callOdoo(odooUrl: string, sessionId: string, model: string, domain: any[], fields: string[], limit = 80, order?: string) {
  const url = `${odooUrl.replace(/\/$/, "")}/web/dataset/call_kw`;
  const resp = await fetchT(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": `session_id=${sessionId}` },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: Date.now(),
      params: {
        model, method: "search_read",
        args: [domain],
        kwargs: { fields, limit, ...(order ? { order } : {}) }
      }
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || "Erreur Odoo");
  return data.result || [];
}

async function callClaude(messages: any[], system?: string, maxTokens = 1024) {
  const resp = await fetchT("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || "Erreur Claude API");
  return data.content[0].text as string;
}

const tryParseJson = (text: string) => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found");
  return JSON.parse(match[0]);
};

export async function POST(req: NextRequest) {
  // ── Rate limiting : 30 requêtes / 60s par IP ──────────────────────────────
  const ip = getClientIp(req);
  const rl = checkRateLimit(`ai:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Trop de requêtes. Réessaie dans ${Math.ceil(rl.resetIn / 1000)}s.` },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    );
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY non configurée dans les variables d'environnement Vercel." }, { status: 500 });
  }

  const { question, odooUrl, sessionId, history } = await req.json();
  if (!question || !odooUrl || !sessionId) {
    return NextResponse.json({ error: "Paramètres manquants (question, odooUrl, sessionId)" }, { status: 400 });
  }

  const SYSTEM_PROMPT = buildSystemPrompt();

  // Contexte conversationnel
  const historyArr = (history as { role: string; text: string; rawData?: any[] }[] | undefined) || [];
  const lastAssistant = historyArr.filter(m => m.role === "assistant").slice(-1)[0];
  const lastAssistantMsg = lastAssistant?.text || "";
  // Récupérer les rawData du dernier message assistant pour les passer au reformat
  const lastRawData = lastAssistant?.rawData || null;

  const contextualQuestion = lastAssistantMsg
    ? `Contexte — ma réponse précédente:\n"""\n${lastAssistantMsg.slice(0, 800)}\n"""\n\nNouvelle demande: ${question}`
    : question;

  try {
    const SYSTEM_PROMPT_USED = SYSTEM_PROMPT;

    // Étape 1 : Claude génère le plan
    const planText = await callClaude(
      [{ role: "user", content: contextualQuestion }],
      SYSTEM_PROMPT_USED, 1024
    );

    let queryPlan: { queries: any[]; reformat?: boolean };

    try {
      queryPlan = tryParseJson(planText);
    } catch {
      // Retry strict
      const retryText = await callClaude([{
        role: "user",
        content: `JSON uniquement, commence par {:\n\n${contextualQuestion}`
      }], SYSTEM_PROMPT_USED, 1024);
      try {
        queryPlan = tryParseJson(retryText);
      } catch {
        // Fallback réponse directe
        const directAnswer = await callClaude([{
          role: "user",
          content: lastAssistantMsg
            ? `Données:\n"""\n${lastAssistantMsg}\n"""\n\nDemande: "${question}"\nRéponds en français.`
            : `Demande: "${question}". Réponds en français.`
        }], undefined, 2048);
        return NextResponse.json({ answer: directAnswer, queriesRun: 0, model: "claude-haiku-4-5", rawData: lastRawData });
      }
    }

    // Reformatisation
    if (queryPlan.reformat || !queryPlan.queries || queryPlan.queries.length === 0) {
      const directAnswer = await callClaude([{
        role: "user",
        content: lastAssistantMsg
          ? `Données précédentes:\n"""\n${lastAssistantMsg}\n"""\n\nDemande: "${question}"\nRéponds en français, reformate si demandé.`
          : `Demande: "${question}". Réponds en français.`
      }], undefined, 2048);
      // Passe les rawData précédentes pour que le bouton Excel reste dispo
      return NextResponse.json({ answer: directAnswer, queriesRun: 0, model: "claude-haiku-4-5", rawData: lastRawData });
    }

    // Étape 2 : Exécuter les requêtes Odoo
    const results: { description: string; model: string; count: number; rows: any[]; error?: string }[] = [];
    for (const q of queryPlan.queries.slice(0, 4)) {
      try {
        const rows = await callOdoo(odooUrl, sessionId, q.model, q.domain || [], q.fields || [], q.limit || 80, q.order);
        results.push({ description: q.description, model: q.model, count: rows.length, rows });
      } catch (e: any) {
        results.push({ description: q.description, model: q.model, count: 0, rows: [], error: e.message });
      }
    }

    // Étape 3 : Claude formate la réponse
    const totalRows = results.reduce((s, r) => s + r.count, 0);
    const dataStr = JSON.stringify(results, null, 2);
    const dataTrunc = dataStr.length > 12000 ? dataStr.slice(0, 12000) + "\n...(tronqué)" : dataStr;

    const answer = await callClaude([{
      role: "user",
      content: `Question: "${question}"\n\nDonnées Odoo (${totalRows} résultat(s)):\n${dataTrunc}\n\nRéponds en français, concis et direct. Listes avec tirets. Prix en €. Si vide, dis-le clairement. Pas de blabla.`
    }], undefined, 2048);

    return NextResponse.json({ answer, queriesRun: results.length, model: "claude-haiku-4-5", rawData: results });

  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Erreur interne" }, { status: 500 });
  }
}
