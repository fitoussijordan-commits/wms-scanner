// app/api/ai-odoo/route.ts
import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `Tu es un assistant expert Odoo qui analyse des questions en français et génère des requêtes JSON-RPC Odoo.

Modèles disponibles:
- product.template: produits (name, default_code, list_price, standard_price, type, categ_id, active, barcode, description_sale, weight, volume)
- product.product: variantes produit (name, default_code, list_price, standard_price, barcode, product_tmpl_id, active)
- stock.quant: quantités en stock (product_id, location_id, quantity, reserved_quantity, lot_id)
- stock.location: emplacements (name, complete_name, usage, active, barcode)
- stock.picking: bons de transfert (name, state, picking_type_code, date, partner_id, origin, scheduled_date, x_studio_date_dexpdition_prvue)
- stock.move.line: lignes de mouvement (product_id, lot_id, qty_done, quantity, location_id, location_dest_id, picking_id, state)
- stock.lot: lots/numéros de série (name, product_id, expiration_date, product_qty)
- purchase.order: commandes fournisseur (name, state, partner_id, amount_total, date_order, date_planned)
- purchase.order.line: lignes commande fournisseur (product_id, product_qty, price_unit, order_id, date_planned)
- sale.order: commandes client (name, state, partner_id, amount_total, date_order)
- res.partner: partenaires/fournisseurs/clients (name, email, phone, supplier_rank, customer_rank)
- product.category: catégories produit (name, complete_name)
- stock.warehouse: entrepôts (name, code)

Valeurs state de stock.picking: draft, waiting, confirmed, assigned (prêt), done (validé), cancel
Valeurs picking_type_code: incoming (réception), outgoing (livraison/OUT), internal (transfert interne)
Pour le stock, usage="internal" pour les emplacements de stockage.

Règles importantes:
- Pour chercher un produit par nom, utilise "ilike" (insensible à la casse, recherche partielle)
- Pour les échantillons, cherche ilike "echantillon" OU ilike "sample" OU dans la catégorie
- Pour les prix, ils sont dans list_price (prix de vente) et standard_price (prix de revient)
- Pour le stock disponible, quantity - reserved_quantity dans stock.quant
- Filtre toujours location_id.usage = "internal" pour le stock (domain: [["location_id.usage","=","internal"]])
- Limites raisonnables: 20-100 résultats selon le contexte

Réponds UNIQUEMENT avec un JSON valide (sans markdown ni backticks) au format exact:
{"queries":[{"model":"nom.modele","domain":[...],"fields":["champ1","champ2"],"limit":50,"order":"champ desc","description":"explication"}]}`;

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

    let queryPlan: { queries: any[] };
    try {
      const cleaned = planText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      queryPlan = JSON.parse(cleaned);
    } catch {
      // Échec de parsing = probablement une demande de reformatisation ou hors-sujet Odoo
      // On laisse Claude répondre directement avec le contexte
      const directAnswer = await callClaude([{
        role: "user",
        content: lastAssistantMsg
          ? `Voici les données que j'ai déjà affichées:\n"""\n${lastAssistantMsg}\n"""\n\nL'utilisateur demande maintenant: "${question}"\n\nRéponds en français, reformate ou complète selon la demande. Si c'est un tableau, utilise du texte formaté avec des séparateurs clairs (pas de HTML).`
          : `L'utilisateur demande: "${question}"\n\nRéponds en français. Si tu ne peux pas répondre sans données Odoo, dis-le clairement.`
      }], undefined, 2048);
      return NextResponse.json({ answer: directAnswer, queriesRun: 0, model: "claude-haiku-4-5" });
    }

    if (!queryPlan.queries || queryPlan.queries.length === 0) {
      // Pas de requêtes → reformatisation ou réponse directe
      const directAnswer = await callClaude([{
        role: "user",
        content: lastAssistantMsg
          ? `Voici les données affichées précédemment:\n"""\n${lastAssistantMsg}\n"""\n\nL'utilisateur demande: "${question}"\n\nRéponds en français.`
          : `L'utilisateur demande: "${question}". Réponds en français.`
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
