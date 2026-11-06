#!/bin/sh
# Rigenera i dati, prova la logica e pubblica app/ sul branch gh-pages, che contiene solo l'ultima versione.
set -e
cd "$(dirname "$0")/.."
npm run data
npm test
site=$(mktemp -d)
trap 'rm -rf "$site"' EXIT
cp -R app/. "$site/"
cp LICENSE NOTICE.md "$site/"
touch "$site/.nojekyll"
name=$(git config user.name)
email=$(git config user.email)
remote=$(git remote get-url origin)
cd "$site"
git init -q -b gh-pages
git add -A
git -c user.name="$name" -c user.email="$email" commit -q -m "Pubblica il sito del $(date +%Y-%m-%d)"
git push -q --force "$remote" gh-pages
echo "Pubblicato: https://alexroat.github.io/tnaa-transit/ (online entro un paio di minuti)"
