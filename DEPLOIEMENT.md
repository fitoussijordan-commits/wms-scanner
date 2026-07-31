# Déploiement — pourquoi `ignoreCommand` dans `vercel.json`

Ce fichier existe parce que `vercel.json` **ne peut pas contenir de commentaires** :
Vercel valide le schéma et refuse toute clé inconnue, y compris `$comment`. Un
essai a fait échouer deux builds de production avec le message
« should NOT have additional property `$comment` ».

## Le problème

Deux projets Vercel sont branchés sur le même dépôt GitHub :

| Projet | Rôle | Branche à construire |
|---|---|---|
| `wms-scanner` | production | `main` |
| `wms-scanner19` | test Odoo 19 | `odoo19` |

Sans filtre, **chaque push déclenche un build dans les deux projets**. Sur l'offre
Hobby un seul build tourne à la fois : l'attente était doublée, et il devenait
difficile de savoir quel déploiement on regardait.

## La solution

`vercel.json` étant partagé par les deux projets, un réglage « Ignored Build Step »
par projet ne suffisait pas. La commande distingue donc les projets par
`VERCEL_PROJECT_ID`, disponible au build.

**Attention, la convention Vercel est inversée** : sortie `1` = on construit,
sortie `0` = on ignore. D'où les conditions niées (`! [ ... ]`).

Un projet non listé construit normalement — le filtre ne bloque jamais par défaut.

## Vérifier après modification

```bash
CMD=$(python3 -c "import json;print(json.load(open('vercel.json'))['ignoreCommand'])")
for id in prj_nKAa9L0hiEGRPLZhvsFSMKTrrfwk prj_6Rg1yVpj9lQmLnblujB6r3KtOHqk; do
  for br in main odoo19; do
    VERCEL_PROJECT_ID=$id VERCEL_GIT_COMMIT_REF=$br bash -c "$CMD"
    echo "$id $br -> $([ $? -eq 1 ] && echo CONSTRUIT || echo ignore)"
  done
done
```

Attendu : `wms-scanner` ne construit que `main`, `wms-scanner19` que `odoo19`.

## À savoir

Ce dispositif deviendra inutile le jour où `wms-scanner19` sera retiré. Depuis
que l'application de production sait basculer entre les bases Odoo 16 et 19
(variable `NEXT_PUBLIC_ODOO_BASES`), le second projet et la branche `odoo19` font
doublon.
