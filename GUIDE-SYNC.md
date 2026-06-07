# Sync automatique Vitalis — Guide d'installation (Cloudflare Workers)

Objectif : Apple Watch → Health Auto Export envoie vos données vers un petit serveur gratuit (Cloudflare Worker), et Vitalis les récupère **automatiquement à chaque ouverture**, sur iPhone comme sur ordinateur.

Durée : ~10 minutes. Aucun logiciel à installer — tout se fait dans le navigateur.

---

## Étape 1 — Créer le compte Cloudflare (gratuit)

1. Allez sur **dash.cloudflare.com** et créez un compte (gratuit, pas de carte bancaire).
2. Dans le menu de gauche : **Compute (Workers)** → **Workers & Pages**.

## Étape 2 — Créer le Worker

1. Cliquez **Create application** → **Create Worker**.
2. Donnez-lui un nom, par ex. `vitalis-sync` → **Deploy**.
3. Cliquez **Edit code**. Effacez tout le code d'exemple.
4. Ouvrez le fichier **`vitalis-worker.js`** (fourni), copiez tout son contenu, collez-le. → **Deploy**.
5. Notez l'URL affichée, du type :
   `https://vitalis-sync.VOTRENOM.workers.dev`

## Étape 3 — Créer le stockage (KV)

1. Menu de gauche : **Storage & Databases** → **KV** → **Create a namespace**.
   Nom : `vitalis_data` (le nom interne importe peu) → **Add**.
2. Retournez dans votre Worker → onglet **Settings** → **Bindings** → **Add** → **KV namespace**.
   - **Variable name** : `HEALTH`  ← (doit être exactement `HEALTH`)
   - **KV namespace** : choisissez `vitalis_data`
   - **Save**.

## Étape 4 — Créer les deux jetons (mots de passe)

Inventez deux mots de passe longs et aléatoires (ex. via un gestionnaire de mots de passe). Exemple :
- WRITE_TOKEN : `w_8f3kZ9...` (servira à Health Auto Export)
- READ_TOKEN : `r_2pQ7vL...` (servira à l'app Vitalis)

Dans le Worker → **Settings** → **Variables and Secrets** → **Add** :
- Nom `WRITE_TOKEN`, valeur = votre write token, type **Secret** → Save.
- Nom `READ_TOKEN`, valeur = votre read token, type **Secret** → Save.

Puis **Deploy** pour appliquer.

## Étape 5 — Configurer Health Auto Export (iPhone)

1. Ouvrez **Health Auto Export** → **Automations** (ou Automated Exports) → **New Automation**.
2. **Automation Type** : `REST API`.
3. **URL** : `https://vitalis-sync.VOTRENOM.workers.dev`
4. **Method** : `POST`  •  **Format** : `JSON`
5. **Headers** → ajoutez :
   - Nom : `Authorization`
   - Valeur : `Bearer VOTRE_WRITE_TOKEN`  (le mot « Bearer », un espace, puis le write token)
6. **Data Types** : cochez ce que Vitalis utilise :
   - Heart Rate Variability (VFC), Resting Heart Rate (FC repos), Respiratory Rate,
     Sleep Analysis (sommeil), Blood Oxygen, Active Energy, Step Count, VO2 Max, Body Mass,
     et **Workouts** (entraînements).
7. **Aggregation** : activez l'agrégation par jour si proposé (recommandé pour le sommeil).
8. **Schedule** : choisissez la fréquence (ex. toutes les heures, ou plusieurs fois/jour).
   Astuce : réglez aussi une plage de dates « Last 30 days » pour la 1ʳᵉ synchro.
9. Enregistrez et lancez un export manuel pour tester (« Run »/« Export now »).

> Note : l'export REST API peut nécessiter l'abonnement de Health Auto Export.

## Étape 6 — Connecter Vitalis

1. Ouvrez **Vitalis** (sante-forme.html) → icône **Réglages** (roue dentée).
2. Section **Sync automatique (Cloudflare)** :
   - **URL du Worker** : `https://vitalis-sync.VOTRENOM.workers.dev`
   - **Jeton de lecture (READ_TOKEN)** : votre read token
3. **Tester la synchronisation**. Si tout est bon : « Sync OK · X jour(s), Y séance(s) ».

C'est terminé. Désormais Vitalis se met à jour tout seul à chaque ouverture, sur iPhone et sur ordinateur.

---

## Vérifier que ça marche / dépannage

- **Tester le Worker dans un navigateur** : ouvrez
  `https://vitalis-sync.VOTRENOM.workers.dev/?token=VOTRE_READ_TOKEN`
  Vous devez voir du JSON (`{"data":{"metrics":[...],...}}`). Si vous voyez `{"error":"unauthorized"}`, le read token ne correspond pas.
- **« HTTP 401 » dans Vitalis** : le READ_TOKEN de l'app ≠ celui du Worker.
- **Health Auto Export renvoie une erreur** : vérifiez le header `Authorization: Bearer <write token>` (le mot Bearer + un espace).
- **Rien ne remonte** : lancez un export manuel dans HAE, attendez 30 s, puis « Synchroniser maintenant » dans Vitalis.
- **Sécurité** : seuls ceux qui ont vos jetons peuvent lire/écrire. Gardez-les privés. Pour les changer, modifiez les Secrets dans Cloudflare et mettez à jour HAE + Vitalis.

## Coûts
Le plan gratuit de Cloudflare Workers couvre 100 000 requêtes/jour et le KV gratuit largement plus que nécessaire pour un usage personnel. Vous ne paierez rien.
