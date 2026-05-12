// app/api/ai-odoo/route.ts
import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `Tu es un générateur de requêtes Odoo JSON-RPC. Tu reçois une question et tu retournes UNIQUEMENT du JSON, rien d'autre.

RÈGLE ABSOLUE: Ta réponse doit commencer par { et finir par }. Pas de texte avant, pas de texte après, pas de markdown, pas d'explication.

Modèles Odoo disponibles:
- product.template: produits (name, default_code, list_price, standard_price, type, categ_id, active, barcode)
- product.product: variantes (name, default_code, list_price, standard_price, barcode)
- stock.quant: stock (product_id, location_id, quantity, reserved_quantity, lot_id) — filtre location_id.usage="internal"
- stock.location: emplacements (name, complete_name, usage, active)
- stock.picking: bons transfert (name, state, picking_type_code, date, partner_id, origin)
- stock.move.line: lignes mouvement (product_id, lot_id, qty_done, quantity, location_id, location_dest_id, picking_id)
- stock.lot: lots (name, product_id, expiration_date, product_qty)
- purchase.order: commandes fournisseur (name, state, partner_id, amount_total, date_order)
- sale.order: commandes client (name, state, partner_id, amount_total, date_order)
- res.partner: partenaires (name, email, phone, supplier_rank, customer_rank)
- product.category: catégories (name, complete_name)

Règles:
- Recherche texte: opérateur "ilike" (insensible casse, partiel)
- Échantillons: domain [["name","ilike","echantillon"]] sur stock.quant avec location_id.usage="internal"
- Stock dispo = quantity - reserved_quantity
- picking_type_code: incoming=réception, outgoing=livraison OUT, internal=transfert
- state picking: draft, waiting, confirmed, assigned=prêt, done=validé, cancel
- Si demande reformatage/tableau des données précédentes: retourne {"queries":[],"reformat":true}

Format JSON obligatoire:
{"queries":[{"model":"stock.quant","domain":[["product_id.name","ilike","echantillon"],["location_id.usage","=","internal"]],"fields":["product_id","quantity","reserved_quantity","location_id"],"limit":100,"description":"stock echantillons"}]}`;

async function callOdoo(odooUrl: string, sessionId: string, model: string, domain: any[], fields: string[], limit = 80, order?: string) {
  const url = `${odooUrl.replace(/\/$/, "")}/web/dataset/call_kw`;
  const resp = await fetch(url, {
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
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
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

export async function POST(req: NextRequest) {
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY non configurée dans les variables d'environnement Vercel." }, { status: 500 });
  }

  const { question, odooUrl, sessionId, history } = await req.json();
  if (!question || !odooUrl || !sessionId) {
    return NextResponse.json({ error: "Paramètres manquants (question, odooUrl, sessionId)" }, { status: 400 });
  }

  // Contexte conversationnel : si l'IA a déjà répondu, on inclut la dernière réponse
  const lastAssistantMsg = (history as { role: string; text: string }[] | undefined)?.filter(m => m.role === "assistant").slice(-1)[0]?.text || "";

  const contextualQuestion = lastAssistantMsg
    ? `Contexte — ma réponse précédente était:\n"""\n${lastAssistantMsg}\n"""\n\nNouvelle demande de l'utilisateur: ${question}`
    : question;

  try {
    // Étape 1 : Claude génère le plan de requêtes Odoo (ou détecte que c'est une reformatisation)
    const planText = await callClaude(
      [{ role: "user", content: contextualQuestion }],
      SYSTEM_PROMPT,
      1024
    );

    let queryPlan: { queries: any[]; reformat?: boolean };

    const tryParseJson = (text: string) => {
      // Extraire le JSON même si Claude a ajouté du texte autour
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON found");
      return JSON.parse(match[0]);
    };

    try {
      queryPlan = tryParseJson(planText);
    } catch {
      // Retry avec un prompt encore plus strict
      const retryText = await callClaude([{
        role: "user",
        content: `Réponds UNIQUEMENT avec du JSON valide, sans aucun texte avant ou après.\n\nQuestion: ${contextualQuestion}\n\nJSON:`
      }], SYSTEM_PROMPT, 1024);
      try {
        queryPlan = tryParseJson(retryText);
      } catch {
        // Vraiment pas du JSON → reformatisation ou réponse directe
        const directAnswer = await callClaude([{
          role: "user",
          content: lastAssistantMsg
            ? `Données précédentes:\n"""\n${lastAssistantMsg}\n"""\n\nDemande: "${question}"\n\nRéponds en français, reformate si demandé.`
            : `Demande: "${question}"\nRéponds en français.`
        }], undefined, 2048);
        return NextResponse.json({ answer: directAnswer, queriesRun: 0, model: "claude-haiku-4-5" });
      }
    }

    // Reformatisation explicite (reformat: true) ou requêtes vides
    if (queryPlan.reformat || !queryPlan.queries || queryPlan.queries.length === 0) {
      const directAnswer = await callClaude([{
        role: "user",
        content: lastAssistantMsg
          ? `Données précédentes:\n"""\n${lastAssistantMsg}\n"""\n\nDemande: "${question}"\n\nRéponds en français, reformate si demandé (tableau avec | pour les colonnes).`
          : `Demande: "${question}". Réponds en français.`
      }], undefined, 2048);
      return NextResponse.json({ answer: directAnswer, queriesRun: 0, model: "claude-haiku-4-5" });
    }

    // Étape 2 : Exécuter les requêtes Odoo
    const results: { description: string; model: string; count: number; rows: any[]; error?: string }[] = [];
    for (const q of queryPlan.queries.slice(0, 4)) { // max 4 requêtes
      try {
        const rows = await callOdoo(odooUrl, sessionId, q.model, q.domain || [], q.fields || [], q.limit || 80, q.order);
        results.push({ description: q.description, model: q.model, count: rows.length, rows });
      } catch (e: any) {
        results.push({ description: q.description, model: q.model, count: 0, rows: [], error: e.message });
      }
    }

    // Étape 3 : Claude formate la réponse en français
    const totalRows = results.reduce((s, r) => s + r.count, 0);
    const dataStr = JSON.stringify(results, null, 2);
    // Tronquer si trop gros
    const dataTrunc = dataStr.length > 12000 ? dataStr.slice(0, 12000) + "\n...(tronqué)" : dataStr;

    const answer = await callClaude(
      [{
        role: "user",
        content: `Question posée: "${question}"\n\nDonnées récupérées depuis Odoo (${totalRows} résultat(s) au total):\n${dataTrunc}\n\nRéponds en français de manière claire et directe. Format:\n- Si c'est une liste: utilise des tirets avec les infos clés\n- Si c'est une valeur unique: donne la réponse directement\n- Pour les prix: affiche en € avec 2 décimales\n- Pour les quantités: arrondis si entier\n- Si données vides: dis clairement qu'aucun résultat n'a été trouvé et suggère une alternative\n- Sois concis, pas de blabla`
      }],
      undefined,
      2048
    );

    return NextResponse.json({ answer, queriesRun: results.length, model: "claude-haiku-4-5" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Erreur interne" }, { status: 500 });
  }
}
