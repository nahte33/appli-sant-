# Vitalis — Santé & Forme

Interface personnelle de suivi santé et entraînement, alimentée par les données Apple Watch
via Health Auto Export. 4 onglets : Récupération, Forme (charge d'entraînement + calendrier),
Notes, Compléments. Assistant IA intégré.

## Structure du dépôt

```
index.html          → l'application (hébergée sur GitHub Pages)
worker/
  vitalis-worker.js → le serveur de sync (déployé sur Cloudflare Workers)
  wrangler.toml     → config de déploiement Cloudflare
GUIDE-SYNC.md       → installation pas à pas de la synchronisation automatique
```

> Aucun secret n'est stocké dans ce dépôt. La clé API de l'assistant et les jetons de
> synchronisation sont saisis dans l'app (stockés localement sur l'appareil) ou définis
> comme Secrets dans Cloudflare. Le dépôt peut donc rester public sans risque.

## 1. Héberger l'app (GitHub Pages)

1. Créez un dépôt GitHub (ex. `vitalis`) et déposez-y ces fichiers.
2. Dépôt → **Settings** → **Pages** → **Build and deployment** → Source : **Deploy from a branch**,
   Branch : `main` / dossier `/ (root)` → **Save**.
3. Au bout d'une minute, l'app est en ligne à : `https://VOTREPSEUDO.github.io/vitalis/`
4. Sur iPhone : ouvrez l'URL dans Safari → Partager → **Sur l'écran d'accueil**. Sur ordi : ajoutez aux favoris.

## 2. Déployer le serveur de sync (Cloudflare)

Voir **GUIDE-SYNC.md** pour le détail. Deux façons :

- **Manuel** : copier-coller `worker/vitalis-worker.js` dans l'éditeur du Worker Cloudflare.
- **Automatique depuis GitHub** : Cloudflare → Workers & Pages → **Create** → **Connect to Git** →
  choisissez ce dépôt, dossier racine `worker/`. À chaque `git push`, le Worker se redéploie.
  (Renseignez l'id KV dans `wrangler.toml` et ajoutez les Secrets `WRITE_TOKEN` / `READ_TOKEN`.)

## 3. Connecter l'app au serveur

Dans l'app → **Réglages** → section **Sync automatique** : collez l'URL du Worker et le
`READ_TOKEN`. L'app se synchronise alors automatiquement à chaque ouverture.

## Workflow de modification

1. On modifie `index.html` ou `worker/vitalis-worker.js`.
2. `git commit` + `git push`.
3. GitHub Pages republie l'app ; Cloudflare redéploie le Worker (si connecté à Git).
