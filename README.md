# Free Movie — static edition

Pixel-matched static export of the sibling Django project. The generated site
runs directly on GitHub Pages and needs no Django server or database. Preferences,
queues, likes, notification state, and comments are stored in the visitor's
browser.

## Build

From this directory, with the sibling `freemovie` project present:

```powershell
python build_static.py
```

## Preview

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/`. GitHub Pages deployment is provided by the
workflow in `.github/workflows/pages.yml`.
