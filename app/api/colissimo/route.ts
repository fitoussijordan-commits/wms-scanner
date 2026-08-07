// app/api/colissimo/route.ts — Connecteur direct La Poste / Colissimo
//
// Envoi en direct avec le contrat Colissimo Entreprise, sans passer par un
// intermédiaire. Le Web Service d'Affranchissement (SLS) crée l'expédition et
// renvoie l'étiquette : plus de ressaisie sur le portail La Poste.
//
// Identifiants EXCLUSIVEMENT côté serveur, comme Odoo, Shopware et TNT. Ce sont
// ceux du contrat : ils permettent d'affranchir, donc d'engager des frais.
//
// Variables d'environnement :
//   COLISSIMO_CONTRACT   numéro de contrat (obligatoire)
//   COLISSIMO_PASSWORD   mot de passe du contrat (obligatoire)
//   COLISSIMO_SANDBOX    "1" pour taper l'environnement de test
//   COLISSIMO_SENDER_*   coordonnées de l'expéditeur (voir expediteur())
import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const BASE = "https://ws.colissimo.fr/sls-ws/SlsServiceWSRest/2.0";
const BASE_TEST = "https://ws.colissimo.fr/sandbox/sls-ws/SlsServiceWSRest/2.0";

/**
 * Offres Colissimo utilisables depuis le WMS.
 *
 * Les codes viennent de la documentation officielle. Les enfermer ici plutôt
 * que de les laisser saisir évite qu'une faute de frappe parte en production
 * sous forme d'affranchissement facturé.
 */
export const OFFRES = [
  { code: "DOM", libelle: "Domicile — sans signature", relais: false },
  { code: "DOS", libelle: "Domicile — avec signature", relais: false },
  { code: "BPR", libelle: "Point Retrait — bureau de poste", relais: true },
  { code: "A2P", libelle: "Point Retrait — relais Pickup / consigne", relais: true },
] as const;

function cfg() {
  return {
    contrat: process.env.COLISSIMO_CONTRACT || "",
    motDePasse: process.env.COLISSIMO_PASSWORD || "",
    base: process.env.COLISSIMO_SANDBOX === "1" ? BASE_TEST : BASE,
    test: process.env.COLISSIMO_SANDBOX === "1",
  };
}

/**
 * Expéditeur : l'entrepôt. Ces valeurs ne changent jamais d'un colis à l'autre,
 * donc elles vivent dans l'environnement plutôt que d'être ressaisies.
 */
function expediteur() {
  return {
    companyName: process.env.COLISSIMO_SENDER_COMPANY || "",
    lastName: process.env.COLISSIMO_SENDER_LASTNAME || "",
    line2: process.env.COLISSIMO_SENDER_ADDRESS || "",
    line3: process.env.COLISSIMO_SENDER_ADDRESS2 || "",
    countryCode: process.env.COLISSIMO_SENDER_COUNTRY || "FR",
    city: process.env.COLISSIMO_SENDER_CITY || "",
    zipCode: process.env.COLISSIMO_SENDER_ZIP || "",
    email: process.env.COLISSIMO_SENDER_EMAIL || "",
    phoneNumber: process.env.COLISSIMO_SENDER_PHONE || "",
  };
}

function expediteurIncomplet(): string[] {
  const e = expediteur();
  const manquants: string[] = [];
  if (!e.companyName && !e.lastName) manquants.push("COLISSIMO_SENDER_COMPANY");
  if (!e.line2) manquants.push("COLISSIMO_SENDER_ADDRESS");
  if (!e.city) manquants.push("COLISSIMO_SENDER_CITY");
  if (!e.zipCode) manquants.push("COLISSIMO_SENDER_ZIP");
  return manquants;
}

/**
 * Extrait le PDF d'une réponse MTOM/multipart.
 *
 * Le service utilise MTOM : la réponse est un message MIME dont une partie est
 * le JSON et l'autre l'étiquette binaire. Un `res.json()` échouerait — d'où ce
 * découpage manuel plutôt qu'une bibliothèque de plus.
 */
function decouperMultipart(buf: Buffer, contentType: string): { json: any; etiquette: Buffer | null } {
  const mb = /boundary="?([^";]+)"?/i.exec(contentType || "");
  if (!mb) {
    // Réponse simple (erreur d'authentification par exemple) : du JSON nu.
    try { return { json: JSON.parse(buf.toString("utf8")), etiquette: null }; }
    catch { return { json: { messages: [{ messageContent: buf.toString("utf8").slice(0, 400) }] }, etiquette: null }; }
  }

  const sep = Buffer.from(`--${mb[1]}`);
  const parties: Buffer[] = [];
  let debut = buf.indexOf(sep);
  while (debut !== -1) {
    const suivant = buf.indexOf(sep, debut + sep.length);
    if (suivant === -1) break;
    parties.push(buf.subarray(debut + sep.length, suivant));
    debut = suivant;
  }

  let json: any = null;
  let etiquette: Buffer | null = null;
  for (const partie of parties) {
    // Les en-têtes de la partie sont séparés du corps par une ligne vide.
    const coupe = partie.indexOf("\r\n\r\n");
    if (coupe === -1) continue;
    const entetes = partie.subarray(0, coupe).toString("utf8").toLowerCase();
    // Retirer le CRLF final qui appartient au délimiteur, pas au contenu.
    let corps = partie.subarray(coupe + 4);
    if (corps.length >= 2 && corps[corps.length - 2] === 0x0d && corps[corps.length - 1] === 0x0a) {
      corps = corps.subarray(0, corps.length - 2);
    }
    if (entetes.includes("application/json")) {
      try { json = JSON.parse(corps.toString("utf8")); } catch { /* partie illisible */ }
    } else if (entetes.includes("application/octet-stream") || entetes.includes("application/pdf")) {
      etiquette = corps;
    }
  }
  return { json, etiquette };
}

/** Message d'erreur lisible plutôt qu'un objet brut de La Poste. */
function messageErreur(json: any): string {
  const msgs: any[] = json?.messages || [];
  const dur = msgs.find((m: any) => String(m.type || "").toUpperCase() === "ERROR") || msgs[0];
  if (dur) return `${dur.id ? `[${dur.id}] ` : ""}${dur.messageContent || "Erreur Colissimo"}`;
  return "Erreur Colissimo sans détail";
}

export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`colis:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });

  const c = cfg();
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "config";

  if (action === "config") {
    // Ne renvoie JAMAIS les identifiants — seulement s'ils sont présents.
    return NextResponse.json({
      configure: !!(c.contrat && c.motDePasse),
      test: c.test,
      expediteurManquant: expediteurIncomplet(),
      offres: OFFRES,
    });
  }

  return NextResponse.json({ error: `Action inconnue : ${action}` }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`colisw:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });

  // Affranchir engage des frais réels : on exige le jeton d'écriture interne,
  // comme pour toute action du WMS qui a des conséquences hors de l'écran.
  const attendu = process.env.WMS_WRITE_TOKEN || "";
  if (!attendu || req.headers.get("x-wms-token") !== attendu) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const c = cfg();
  if (!c.contrat || !c.motDePasse) {
    return NextResponse.json({ error: "Colissimo non configuré (COLISSIMO_CONTRACT / COLISSIMO_PASSWORD)" }, { status: 503 });
  }
  const manquants = expediteurIncomplet();
  if (manquants.length) {
    return NextResponse.json({ error: `Adresse expéditeur incomplète : ${manquants.join(", ")}` }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "label";
  if (action !== "label" && action !== "check") {
    return NextResponse.json({ error: `Action inconnue : ${action}` }, { status: 400 });
  }

  try {
    const b = await req.json();

    const nom = String(b.nom || "").trim();
    const adresse = String(b.adresse || "").trim();
    const ville = String(b.ville || "").trim();
    const cp = String(b.cp || "").trim();
    const pays = String(b.pays || "FR").toUpperCase();
    const offre = String(b.offre || "DOM").toUpperCase();
    const poids = Number(b.poids);

    if (!nom || !adresse || !ville || !cp) {
      return NextResponse.json({ error: "Nom, adresse, code postal et ville sont requis" }, { status: 400 });
    }
    if (!OFFRES.some(o => o.code === offre)) {
      return NextResponse.json({ error: `Offre inconnue : ${offre}` }, { status: 400 });
    }
    // Colissimo raisonne en grammes et refuse un poids nul. Un colis sans poids
    // saisi partirait sinon à 0 g, ce que le service rejette avec un message
    // obscur — autant le dire ici.
    if (!(poids > 0)) {
      return NextResponse.json({ error: "Poids du colis requis (en kg)" }, { status: 400 });
    }

    const relais = OFFRES.find(o => o.code === offre)?.relais;
    const pointRetrait = String(b.pointRetrait || "").trim();
    if (relais && !pointRetrait) {
      return NextResponse.json({
        error: "Cette offre exige l'identifiant du point de retrait — à choisir via l'API Point Retrait",
      }, { status: 400 });
    }

    const lettre: any = {
      service: {
        productCode: offre,
        depositDate: new Date().toISOString().slice(0, 10),
        // Sans ce drapeau, une adresse mal formée passe silencieusement et le
        // colis part en anomalie. Mieux vaut un refus immédiat.
        transportationAmount: 0,
        totalAmount: 0,
        orderNumber: String(b.reference || "").slice(0, 30),
        commercialName: process.env.COLISSIMO_SENDER_COMPANY || "",
      },
      parcel: {
        weight: Math.round(poids * 1000) / 1000,
      },
      sender: { senderParcelRef: String(b.reference || "").slice(0, 30), address: expediteur() },
      addressee: {
        addresseeParcelRef: String(b.reference || "").slice(0, 30),
        address: {
          lastName: nom,
          companyName: String(b.societe || "").trim(),
          line2: adresse,
          line3: String(b.adresse2 || "").trim(),
          countryCode: pays,
          city: ville,
          zipCode: cp,
          email: String(b.email || "").trim(),
          mobileNumber: String(b.telephone || "").trim(),
        },
      },
    };
    if (relais) lettre.service.pickupLocationId = pointRetrait;

    const payload = {
      contractNumber: c.contrat,
      password: c.motDePasse,
      outputFormat: {
        x: 0, y: 0,
        outputPrintingType: String(b.format || "PDF_10x15_300dpi"),
      },
      letter: lettre,
    };

    // `checkGenerateLabel` valide la requête SANS créer d'expédition ni
    // facturer. Indispensable pour tester un paramétrage sans consommer.
    const methode = action === "check" ? "checkGenerateLabel" : "generateLabel";
    const res = await fetchT(`${c.base}/${methode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "multipart/related, application/json" },
      body: JSON.stringify(payload),
    }, 25_000);

    const brut = Buffer.from(await res.arrayBuffer());
    const { json, etiquette } = decouperMultipart(brut, res.headers.get("content-type") || "");

    const erreurs: any[] = (json?.messages || []).filter((m: any) => String(m.type || "").toUpperCase() === "ERROR");
    if (!res.ok || erreurs.length) {
      return NextResponse.json({ error: messageErreur(json), messages: json?.messages || [] }, { status: 400 });
    }

    const numero = json?.labelV2Response?.parcelNumber || json?.labelResponse?.parcelNumber || "";
    if (action === "check") {
      return NextResponse.json({ ok: true, test: c.test, messages: json?.messages || [] });
    }

    if (!etiquette) {
      // L'expédition est peut-être créée sans que l'étiquette soit revenue :
      // on renvoie le numéro pour que rien ne soit perdu, et on le dit.
      return NextResponse.json({
        error: "Expédition créée mais étiquette absente de la réponse",
        numero,
      }, { status: 502 });
    }

    return NextResponse.json({
      numero,
      test: c.test,
      offre,
      etiquetteBase64: etiquette.toString("base64"),
      format: String(b.format || "PDF_10x15_300dpi"),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Erreur Colissimo" }, { status: 500 });
  }
}
